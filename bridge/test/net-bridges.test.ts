import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { pathsFor } from "../src/config.ts";
import { writeLinks } from "../src/fleet/links.ts";
import { threadVariables } from "../src/portals/access.ts";
import { closeCode, createThread, password, socketURL, startTestBridge, TestClient, username, type TestBridge } from "./helpers.ts";

// The net between real bridges (docs/net-plan.md, milestone N1): three bridges on this
// Mac stand in for three Macs, each in a folder of its own on a port of its own, with
// the scripted agent alone. The rules themselves are in net.test.ts.

let a: TestBridge;
let b: TestBridge;
let c: TestBridge;
/** A bridge outside the net, which A reaches by a link made by hand (`links.json`). */
let d: TestBridge;
/** A password client of each: the password and ticket path, as the app has it today. */
let toA: TestClient;
let toB: TestClient;
let toC: TestClient;
/** A thread on each, to find in the others' lists. */
const threads: Record<string, string> = {};

before(async () => {
  a = await startTestBridge({ config: { fleet: { name: "Mac A" } } });
  b = await startTestBridge({ config: { fleet: { name: "Mac B" } } });
  // Kept for a restart.
  c = await startTestBridge({ config: { fleet: { name: "Mac C" } }, keepHome: true });
  d = await startTestBridge({ config: { fleet: { name: "Mac D" } } });
  toA = await TestClient.open(a);
  toB = await TestClient.open(b);
  toC = await TestClient.open(c);
  threads.a = await createThread(toA);
  threads.b = await createThread(toB);
  threads.c = await createThread(toC);
  const toD = await TestClient.open(d);
  threads.d = await createThread(toD);
  await toD.close();
});

after(async () => {
  await Promise.all([toA, toB, toC].map((client) => client.close()));
  await Promise.all([a, b, c, d].map((bridge) => bridge.dispose()));
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

/** The ids of the members a bridge lists, those removed marked so. */
async function members(client: TestClient): Promise<string[]> {
  const listed = await client.call("net.list");
  return listed.members.map((member: { id: string; removed?: boolean }) => (member.removed ? `${member.id} removed` : member.id)).sort();
}

/** Joins a device through `bridge`, as the app does: a code from a member, then `POST /net/join`. */
async function joinDevice(bridge: TestBridge, inviter: TestClient, id: string): Promise<{ token: string; net: string }> {
  const { code } = await inviter.call("net.invite");
  const response = await fetch(`${bridge.url}/net/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, member: { id, kind: "device", name: "iPhone", platform: "ios" } }),
  });
  assert.equal(response.status, 200);
  const answer = (await response.json()) as { token: string; net: string; member: Record<string, unknown>; members: Record<string, unknown>[] };
  assert.equal(answer.member.id, id);
  assert.ok(answer.members.every((member) => !("token_hash" in member)));
  return answer;
}

let netID = "";
let machineOf: Record<string, string> = {};

test("a Mac that joins through B is linked to A and C both ways, by the net's names, and a link made by hand still works", async () => {
  machineOf = { a: toA.readyPayload.bridge.machine.id, b: toB.readyPayload.bridge.machine.id, c: toC.readyPayload.bridge.machine.id };
  // Alone at first: each a net of one, with its revision in gateway.ready.
  const alone = await toA.call("net.list");
  assert.deepEqual(toA.readyPayload.bridge.net, { id: alone.net, revision: alone.revision });
  assert.deepEqual(alone.members.map((member: { id: string }) => member.id), [machineOf.a]);
  assert.equal(alone.here, machineOf.a);
  assert.equal(alone.you, null);

  // B joins A's net with a code A made, then C joins through B.
  const joined = await toB.call("net.join_with", { link: (await toA.call("net.invite")).link });
  netID = alone.net;
  assert.equal(joined.net, netID);
  const invite = await toB.call("net.invite");
  assert.match(invite.link, /^portals:\/\/join\?v=1&url=http%3A%2F%2F127\.0\.0\.1%3A\d+&code=[A-Za-z0-9_-]{22}&name=Mac%20B$/);
  assert.equal(invite.url, b.url);
  assert.ok(invite.expires_at > Date.now());
  await toC.call("net.join_with", { link: invite.link });
  const everyMac = [machineOf.a, machineOf.b, machineOf.c].sort();
  for (const client of [toA, toB, toC]) {
    await eventually(async () => JSON.stringify(await members(client)) === JSON.stringify(everyMac), "every Mac lists the three");
    assert.equal((await client.call("net.list")).net, netID);
  }

  // A link made by hand, to a Mac outside the net, and one whose name a net Mac has (left out).
  writeLinks(pathsFor(a.home).links, [
    { name: "mac-d", url: d.url, user: username, password },
    { name: "mac-c", url: d.url, user: username, password },
  ]);
  // Both ways: every Mac lists the others' threads, by the net's names for them, with no password.
  const listed = await eventually(async () => {
    const all = await toA.call("threads.list");
    return all.threads.some((thread: { id: string }) => thread.id === `mac-c/${threads.c}`) && all;
  }, "A lists C's threads");
  const ids = listed.threads.map((thread: { id: string }) => thread.id);
  for (const expected of [threads.a, `mac-b/${threads.b}`, `mac-c/${threads.c}`, `mac-d/${threads.d}`]) assert.ok(ids.includes(expected), expected);
  assert.deepEqual(listed.machines.map((machine: { name: string; url: string; reachable: boolean }) => [machine.name, machine.url, machine.reachable]), [
    ["mac-b", b.url, true],
    ["mac-c", c.url, true],
    ["mac-d", d.url, true],
  ]);
  for (const [client, expected] of [
    [toB, [`mac-a/${threads.a}`, `mac-c/${threads.c}`]],
    [toC, [`mac-a/${threads.a}`, `mac-b/${threads.b}`]],
  ] as const) {
    const all = await client.call("threads.list");
    for (const id of expected) assert.ok(all.threads.some((thread: { id: string }) => thread.id === id), id);
  }
  // A message passed on to another Mac of the net: the call goes through with A's token.
  const read = await toA.call("thread.read", { thread: `mac-c/${threads.c}` });
  assert.equal(read.thread.id, `mac-c/${threads.c}`);
});

let phone: { token: string; net: string };
let onA: TestClient;

test("a device joined through A connects to B and C with its token, with no ticket, and registers for notifications with it", async () => {
  phone = await joinDevice(a, toA, "phone-0000-0001");
  assert.equal(phone.net, netID);
  // C may hear of it from A, from B, or only when it comes: a token it does not know has it ask first.
  onA = await TestClient.open(a, { token: phone.token });
  for (const bridge of [b, c]) {
    const device = await TestClient.open(bridge, { token: phone.token });
    const listed = await device.call("net.list");
    assert.equal(listed.you, "phone-0000-0001");
    assert.equal(device.readyPayload.bridge.net.id, netID);
    assert.ok(listed.members.every((member: Record<string, unknown>) => !("token_hash" in member)));
    // Each with its token's tag instead, the same on every Mac (net-5).
    assert.ok(listed.members.every((member: Record<string, unknown>) => typeof member.token_tag === "string"));
    const tags = (list: { members: { id: string; token_tag: string }[] }) => Object.fromEntries(list.members.map((member) => [member.id, member.token_tag]));
    const listedOnA = tags(await toA.call("net.list"));
    for (const [id, tag] of Object.entries(tags(listed))) if (id in listedOnA) assert.equal(listedOnA[id], tag, id);
    // A device may do what the app does.
    assert.ok((await device.call("threads.list")).threads.length >= 3);
    // Not what is the Macs' alone.
    await assert.rejects(device.call("net.sync", { net: netID, members: [] }), { code: 4003 });
    await assert.rejects(device.call("net.leave"), { code: 4003 });
    await device.close();
  }

  // The push routes take the token too; the registration is the device's.
  const registered = await fetch(`${b.url}/api/plugins/aeriportal-push/registration`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${phone.token}` },
    body: JSON.stringify({ device: { token: "ab".repeat(32), bundle_id: "com.danielou.portals", environment: "sandbox" }, threads: [{ id: threads.b, agent: "fake", agent_name: "Fake", title: "" }] }),
  });
  assert.equal(registered.status, 200);
  const push = JSON.parse(readFileSync(pathsFor(b.home).push, "utf8"));
  assert.equal(push.devices["ab".repeat(32)].member, "phone-0000-0001");
  const refused = await fetch(`${b.url}/api/plugins/aeriportal-push/status`, { headers: { Authorization: `Bearer ${"x".repeat(43)}` } });
  assert.equal(refused.status, 401);

  // A token nobody knows, and no ticket at all: 4401.
  assert.equal(await closeCode(new WebSocket(socketURL(b, ""), { headers: { Authorization: `Bearer ${"y".repeat(43)}` } })), 4401);
  assert.equal(await closeCode(new WebSocket(socketURL(b, ""))), 4401);
});

test("a removal on C keeps the device out of A and closes its connection there with 4401", async () => {
  const closing = onA.closed;
  // One for another net (a device that left that net asking a Mac of it, which has moved
  // since into the net the device is in now) takes nobody out.
  await assert.rejects(toC.call("net.remove", { member: "phone-0000-0001", net: "0123456789abcdef" }), { message: "This Mac is not in that net any more: nothing was removed." });
  assert.ok((await members(toA)).includes("phone-0000-0001") && !(await members(toC)).includes("phone-0000-0001 removed"));
  await toC.call("net.remove", { member: "phone-0000-0001", net: netID });
  assert.equal(await closing, 4401);
  for (const bridge of [a, b, c]) {
    assert.equal(await closeCode(new WebSocket(socketURL(bridge, ""), { headers: { Authorization: `Bearer ${phone.token}` } })), 4401);
  }
  for (const client of [toA, toB]) {
    await eventually(async () => (await members(client)).includes("phone-0000-0001 removed"), "the removal reached every Mac");
  }
  // Its registration went with it.
  await eventually(async () => !(("ab".repeat(32)) in JSON.parse(readFileSync(pathsFor(b.home).push, "utf8")).devices), "B forgot the device's registration");
  // A Mac cannot remove itself so, nor can another Mac remove a member.
  await assert.rejects(toC.call("net.remove", { member: machineOf.c }), { message: "A Mac cannot remove itself: run `portals net leave` on it." });
});

test("a bridge stopped during a change catches up when started again", async () => {
  const tablet = await joinDevice(b, toB, "ipad-0000-0002");
  await eventually(async () => (await members(toC)).includes("ipad-0000-0002"), "C heard of the tablet");
  await toC.close();
  const home = c.home;
  await c.close();
  // While C is off, the tablet is removed on A.
  await toA.call("net.remove", { member: "ipad-0000-0002" });
  // C comes back, on another port: it asks the others as it starts, and they learn its new address.
  c = await startTestBridge({ home, keepHome: true });
  toC = await TestClient.open(c);
  await eventually(async () => (await members(toC)).includes("ipad-0000-0002 removed"), "C caught up with the removal");
  assert.equal(await closeCode(new WebSocket(socketURL(c, ""), { headers: { Authorization: `Bearer ${tablet.token}` } })), 4401);
  await eventually(async () => {
    const all = await toA.call("threads.list");
    return all.machines.some((machine: { name: string; url: string; reachable: boolean }) => machine.name === "mac-c" && machine.url === c.url && machine.reachable);
  }, "A reaches C at its new address");
});

/** Runs the `portals` command against `home`'s bridge, with `input` piped in. */
function portals(args: string[], home: string, input = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, PORTALS_BRIDGE_HOME: home };
  for (const name of threadVariables) delete env[name];
  const script = fileURLToPath(new URL("../src/portals.ts", import.meta.url));
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

test("the portals command lists the net, makes a join link, joins with one from its input and leaves; the agents' guide says nothing of it", async () => {
  const listed = await portals(["net"], a.home);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).net, netID);
  const invite = await portals(["net", "invite"], a.home);
  assert.match(JSON.parse(invite.stdout).link, /^portals:\/\/join\?v=1&/);
  // D, alone, joins A's net from a link piped in, then leaves it: A no longer lists it.
  const joined = await portals(["net", "join"], d.home, `${JSON.parse(invite.stdout).link}\n`);
  assert.equal(joined.code, 0, joined.stderr);
  assert.equal(JSON.parse(joined.stdout).net, netID);
  const dID = JSON.parse(joined.stdout).here;
  await eventually(async () => (await members(toA)).includes(dID), "A lists D");
  const left = await portals(["net", "leave"], d.home);
  assert.equal(left.code, 0, left.stderr);
  assert.notEqual(JSON.parse(left.stdout).net, netID);
  await eventually(async () => (await members(toA)).includes(`${dID} removed`), "A lists D as removed");
  // Only the person at the Mac leaves: not with the password.
  await assert.rejects(toA.call("net.leave"), { code: 4003 });
  const wrong = await portals(["net", "join", "portals://join?v=2&url=http%3A%2F%2F127.0.0.1%3A1&code=x"], d.home);
  assert.equal(wrong.code, 1);
  assert.equal(JSON.parse(wrong.stderr).error.message, "Update Portals to join this net.");
  assert.equal((await portals(["net", "nothing"], d.home)).code, 2);
  const guide = await portals(["guide"], a.home);
  assert.doesNotMatch(guide.stdout, /portals net/);
  assert.match((await portals(["help"], a.home)).stdout, /portals net invite/);
});

test("a Mac removed while it was off comes back at another address, finds itself out and starts a net of its own, and the others keep it out", async () => {
  await toC.close();
  const home = c.home;
  const cID = (await toA.call("net.list")).members.find((member: { name: string }) => member.name === "Mac C").id;
  await c.close();
  await toA.call("net.remove", { member: cID });
  c = await startTestBridge({ home, keepHome: true });
  toC = await TestClient.open(c);
  await eventually(async () => (await toC.call("net.list")).net !== netID, "C started a net of its own");
  assert.deepEqual(await members(toC), [cID]);
  assert.ok((await members(toA)).includes(`${cID} removed`));
  assert.ok((await members(toB)).includes(`${cID} removed`));
});
