import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { after, before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { pathsFor } from "../src/config.ts";
import { LinkError, machineName, parsePairingLink, readLinks, thisMachine, writeLinks, type Link } from "../src/fleet/links.ts";
import { threadVariables } from "../src/portals/access.ts";
import { pairingLink } from "../src/setup/pairing.ts";
import { createThread, isEvent, password, runTurn, signIn, startTestBridge, TestClient, username, type Frame, type RpcFailure, type TestBridge } from "./helpers.ts";

// Links between Macs (docs/fleet-plan.md): one bridge reaching another's threads as a
// client of it. Two bridges on this Mac stand in for two Macs: `here` is linked to
// `there`, and not the other way round.

const script = fileURLToPath(new URL("../src/portals.ts", import.meta.url));

let here: TestBridge;
let there: TestBridge;
/** The stable id `here` gave itself (`state/machine.json`), and its name for itself (`fleet.name`). */
let hereID: string;
const hereName = "Here Mac";

function linkTo(bridge: TestBridge, name: string, change: Partial<Link> = {}): Link {
  return { name, url: bridge.url, user: username, password, ...change };
}

before(async () => {
  // Slow enough over there that a `slow` turn is still running when the next call arrives.
  there = await startTestBridge({ config: { fake: { delayMs: 3 }, fleet: { name: "There Mac" } } });
  here = await startTestBridge({ config: { fleet: { name: hereName } } });
  hereID = JSON.parse(readFileSync(pathsFor(here.home).machine, "utf8")).id;
  writeLinks(pathsFor(here.home).links, [linkTo(there, "there")]);
});

after(() => Promise.all([here.dispose(), there.dispose()]));

/** An address on this Mac that nothing answers at. */
async function deadAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** A client of each bridge, and a thread over there that has had one turn. */
async function setUp(t: TestContext): Promise<{ near: TestClient; far: TestClient; thread: string; name: string }> {
  const near = await TestClient.open(here);
  const far = await TestClient.open(there);
  t.after(() => Promise.all([near.close(), far.close()]));
  const thread = await createThread(far);
  await runTurn(far, thread, "over there");
  return { near, far, thread, name: `there/${thread}` };
}

/** Runs the `portals` command against `home`'s bridge, with `input` piped in. */
function run(args: string[], home: string, input = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, PORTALS_BRIDGE_HOME: home };
  for (const name of threadVariables) delete env[name];
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

test("a pairing link is read as setup writes it, and a Mac's name is made fit for a thread's name", () => {
  const pairing = { url: "https://mini.tail1234.ts.net:10010", user: "dana", password: "p@ss word&=", name: "Dana’s Mac mini" };
  assert.deepEqual(parsePairingLink(pairingLink(pairing)), pairing);
  assert.deepEqual(parsePairingLink(` ${pairingLink({ ...pairing, name: undefined })}\n`), { url: pairing.url, user: "dana", password: pairing.password });
  for (const bad of ["mini", "https://mini.tail1234.ts.net:10010", "portals://pair?v=1&url=https%3A%2F%2Fx&user=u", "portals://pair?v=2&url=https%3A%2F%2Fx&user=u&password=p"]) {
    assert.throws(() => parsePairingLink(bad), LinkError, bad);
  }
  assert.equal(machineName("Dana’s Mac mini"), "dana-s-mac-mini");
  assert.equal(machineName("MBP16.local"), "mbp16");
  assert.equal(machineName("  "), "");
});

test("machines.list lists a linked Mac with its agents", async (t) => {
  const { near } = await setUp(t);
  assert.deepEqual((await near.call("machines.list")).machines, [{ name: "there", url: there.url, reachable: true, agents: [{ name: "fake", display_name: "Fake agent" }] }]);
});

test("threads.list lists the linked Mac's threads beside this bridge's own, named by the Mac", async (t) => {
  const { near, far, thread, name } = await setUp(t);
  const own = await createThread(near);

  const listed = await near.call("threads.list");
  const remote = listed.threads.find((entry: Frame) => entry.id === name);
  assert.equal(remote.machine, "there");
  assert.equal(remote.title, "Fake: over there");
  assert.equal(remote.state, "idle");
  assert.equal(listed.threads.find((entry: Frame) => entry.id === own).machine, undefined);
  assert.deepEqual(listed.machines, [{ name: "there", url: there.url, reachable: true }]);

  // Asked for its own only, and a bridge with no links, say nothing of machines.
  const local = await near.call("threads.list", { local: true });
  assert.equal(local.machines, undefined);
  assert.ok(local.threads.every((entry: Frame) => !entry.id.includes("/")));
  const over = await far.call("threads.list");
  assert.equal(over.machines, undefined);
  assert.ok(over.threads.some((entry: Frame) => entry.id === thread));
});

test("a thread on a linked Mac is read, sent to, waited for and stopped from here, and its messages say where they are from", async (t) => {
  const { near, far, thread, name } = await setUp(t);
  const sender = await createThread(near);
  await runTurn(near, sender, "hi there");

  const reading = await near.call("thread.read", { thread: name });
  assert.equal(reading.thread.id, name);
  assert.equal(reading.thread.machine, "there");
  assert.equal(reading.messages[0].text, "over there");

  const sent = await near.call("thread.send", { thread: name, text: "hello across", from: sender, wait: true });
  assert.equal(sent.status, "streaming");
  assert.equal(sent.state, "idle");
  await near.call("thread.send", { thread: name, text: "and again", wait: true });
  const got = (await far.call("thread.read", { thread, last: 2 })).messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text);
  // Named by the Mac's name for itself, never its host name on the network (a DHCP name on
  // a campus Wi-Fi), and the thread by the Mac's stable id and its own.
  assert.deepEqual(got, [
    `[Portals: from Fake agent · "Fake: hi there" (thread ${hereID}/${sender}) on ${hereName}]\nhello across`,
    `[Portals: from the command line (machine ${hereID}) on ${hereName}]\nand again`,
  ]);
  // A device over there is given who as facts (feature senders), as stored and as it happens.
  const resumed = (await far.call("session.resume", { session_id: thread, profile: "fake" })).messages.filter((message: Frame) => message.role === "user");
  assert.deepEqual(resumed.slice(-2).map((message: Frame) => message.from), [
    { agent_name: "Fake agent", title: "Fake: hi there", thread: sender, machine: hereID, machine_name: hereName },
    { machine: hereID, machine_name: hereName },
  ]);
  const before = far.frames.length;
  await near.call("thread.send", { thread: name, text: "live", from: sender, wait: true });
  const opened = await far.from(before, (frame) => isEvent(frame, "message.start", thread));
  assert.deepEqual(opened.params.payload.from, { agent_name: "Fake agent", title: "Fake: hi there", thread: sender, machine: hereID, machine_name: hereName });

  await near.call("thread.send", { thread: name, text: "slow please" });
  const waited = await near.call("thread.wait", { thread: name, timeout_ms: 20 });
  assert.equal(waited.timed_out, true);
  assert.equal(waited.state, "working");
  assert.deepEqual(await near.call("thread.stop", { thread: name }), { stopped: true });
  assert.equal((await near.call("thread.wait", { thread: name })).state, "idle");
});

test("a wait on a linked Mac's thread is at most an hour and at least none, as on this Mac: one longer than a timer can be still waits, and the Mac stays in the listings", async (t) => {
  const { near, name } = await setUp(t);
  // Thirty days: more milliseconds than a timer holds, which would fire at once.
  const month = 2_592_000_000;
  await near.call("thread.send", { thread: name, text: "slow please" });
  const waited = await near.call("thread.wait", { thread: name, timeout_ms: month });
  assert.deepEqual([waited.state, waited.timed_out], ["idle", false]);
  const sent = await near.call("thread.send", { thread: name, text: "and again", wait: true, timeout_ms: month });
  assert.deepEqual([sent.state, sent.timed_out], ["idle", false]);
  const started = await near.call("thread.start", { machine: "there", profile: "fake", text: "start over there", wait: true, timeout_ms: month });
  assert.deepEqual([started.state, started.timed_out], ["idle", false]);
  // The command gives the bridge as long as the bridge waits, not longer than its own timer holds.
  const printed = await run(["wait", name, "--timeout", String(month)], here.home);
  assert.deepEqual([printed.code, JSON.parse(printed.stdout || "{}").state, printed.stderr], [0, "idle", ""]);

  // Less than none is none: the thread as it is, at once.
  await near.call("thread.send", { thread: name, text: "slow, and not waited for" });
  const none = await near.call("thread.wait", { thread: name, timeout_ms: -60_000 });
  assert.deepEqual([none.state, none.timed_out], ["working", true]);
  assert.deepEqual(await near.call("thread.stop", { thread: name }), { stopped: true });
  await near.call("thread.wait", { thread: name });

  // None of it made the Mac look away: it is still listed.
  assert.deepEqual((await near.call("machines.list", {})).machines.map((machine: Frame) => [machine.name, machine.reachable]), [["there", true]]);
});

test("thread.start with a machine starts the thread on that Mac, in one of its folders", async (t) => {
  const { near, far } = await setUp(t);

  const started = await near.call("thread.start", { machine: "there", profile: "fake", text: "start over there", wait: true });
  assert.match(started.thread.id, /^there\/[0-9a-f-]{36}$/);
  assert.equal(started.thread.machine, "there");
  assert.equal(started.state, "idle");
  const id = started.thread.id.slice("there/".length);
  assert.ok((await far.call("threads.list", { local: true })).threads.some((entry: Frame) => entry.id === id));
  assert.equal((await far.call("thread.read", { thread: id })).messages[0].text, `[Portals: from the command line (machine ${hereID}) on ${hereName}]\nstart over there`);
  // Not a thread of this bridge.
  assert.ok((await near.call("threads.list", { local: true })).threads.every((entry: Frame) => entry.id !== id));

  assert.equal((await near.call("folders.list", { machine: "there" })).general.name, "General");
  await assert.rejects(near.call("thread.start", { machine: "there", profile: "nobody" }), (error: RpcFailure) => error.code === -32602 && /no agent called nobody/.test(error.message));
});

test("a thread started from one of this Mac's threads on a linked Mac is answered by that thread only, its mode told by this Mac (feature agent_threads)", async (t) => {
  const { near, far } = await setUp(t);
  const parent = await createThread(near);
  const started = await near.call("thread.start", { machine: "there", profile: "fake", from: parent, text: "approve please", wait: true, timeout_ms: 5000 });
  assert.equal(started.state, "blocked");
  const name = started.thread.id as string;
  const id = name.slice("there/".length);
  const request = started.open_requests[0];
  await far.call("session.resume", { session_id: id, profile: "fake" });

  // There, it is known by this Mac's host name for the thread (as older bridges knew it),
  // which no device is shown, and by facts with this Mac's stable id, which every device is
  // (feature senders), so that it can be put under the thread that started it.
  const origin = `${thisMachine()}/${parent}`;
  const from = { agent: "fake", agent_name: "Fake agent", thread: parent, machine: hereID, machine_name: hereName };
  const record = JSON.parse(readFileSync(pathsFor(there.home).threads, "utf8")).threads.find((entry: Frame) => entry.id === id);
  assert.deepEqual(record.startedBy, { name: `Fake agent on ${hereName}`, origin, from });
  const listed = (await far.call("threads.changes")).threads.find((entry: Frame) => entry.id === id);
  assert.deepEqual(listed.started_by, { name: `Fake agent on ${hereName}`, from });

  const refused = (words: RegExp) => (error: RpcFailure) => error.code === -32602 && words.test(error.message);
  const answer = (client: TestClient, params: Record<string, unknown>) => client.call("thread.answer", { request: request.id, ...params });
  await assert.rejects(answer(near, { thread: name, choice: "deny" }), refused(/^Only the thread that started/));
  await assert.rejects(answer(near, { thread: name, choice: "deny", from: "no-such-thread" }), refused(/^Only the thread that started/));
  // The fake agent has no modes: its thread can only say no.
  await assert.rejects(answer(near, { thread: name, choice: "once", from: parent }), refused(/the mode yours runs in is not known/));
  await assert.rejects(answer(far, { thread: id, choice: "deny", origin: `${thisMachine()}/another`, caller_mode: "full" }), refused(/^Only the thread that started/));
  await assert.rejects(answer(far, { thread: id, choice: "deny", from: parent }), refused(/^Only the thread that started/));
  // Passed on with facts, it is the same Mac's same thread that answers, whatever the origin says.
  await assert.rejects(answer(far, { thread: id, choice: "deny", origin, sent_by: { ...from, thread: "another" }, caller_mode: "full" }), refused(/^Only the thread that started/));
  await assert.rejects(answer(far, { thread: id, choice: "deny", origin, sent_by: { ...from, machine: "0000000000000000" }, caller_mode: "full" }), refused(/^Only the thread that started/));

  assert.deepEqual(await answer(near, { thread: name, choice: "deny", from: parent }), { answered: true });
  const cancel = await far.find((frame) => isEvent(frame, "request.cancel", id) && frame.params.payload.id === request.id);
  assert.deepEqual(cancel.params.payload, { id: request.id, reason: "resolved", by: `Fake agent on ${hereName}`, answer: { choice: "deny" } });
  assert.equal((await near.call("thread.wait", { thread: name, timeout_ms: 5000 })).state, "idle");

  // Passed on by a bridge that says its thread is in full access, an allow is taken.
  const again = (await near.call("thread.send", { thread: name, text: "approve this too", from: parent, wait: true, timeout_ms: 5000 })).open_requests[0];
  assert.deepEqual(await far.call("thread.answer", { thread: id, request: again.id, choice: "once", origin, caller_mode: "full", sender: "Fake agent on elsewhere" }), { answered: true });
  assert.match((await near.call("thread.wait", { thread: name, timeout_ms: 5000 })).reply, /The command ran\./);

  // This Mac's host name changed since (a new network): the facts still say it is the same thread.
  const third = (await near.call("thread.send", { thread: name, text: "approve once more", from: parent, wait: true, timeout_ms: 5000 })).open_requests[0];
  assert.deepEqual(await far.call("thread.answer", { thread: id, request: third.id, choice: "once", origin: `dhcp-10-0-0-9/${parent}`, sent_by: from, caller_mode: "full" }), { answered: true });
  assert.match((await near.call("thread.wait", { thread: name, timeout_ms: 5000 })).reply, /The command ran\./);
});

test("a Mac that is not linked, does not answer or does not take the sign-in is said so, and the rest still lists", async (t) => {
  const { near, name } = await setUp(t);
  await assert.rejects(near.call("thread.read", { thread: "nowhere/x" }), (error: RpcFailure) => error.code === 4007 && /no linked Mac called nowhere/.test(error.message));
  // The other bridge's own refusals come back as they are.
  await assert.rejects(near.call("thread.read", { thread: "there/no-such-thread" }), (error: RpcFailure) => error.code === 4007 && /no thread no-such-thread/.test(error.message));

  const links = pathsFor(here.home).links;
  writeLinks(links, [linkTo(there, "there"), { name: "gone", url: await deadAddress(), user: username, password }, linkTo(there, "locked", { password: "not the password" })]);
  t.after(() => writeLinks(links, [linkTo(there, "there")]));

  await assert.rejects(near.call("thread.read", { thread: "gone/x" }), (error: RpcFailure) => error.code === -32603 && /^Could not reach gone: nothing answers at its address/.test(error.message));
  await assert.rejects(near.call("thread.send", { thread: "locked/x", text: "hi" }), (error: RpcFailure) => /^Could not reach locked: it did not take the user name and password/.test(error.message));

  const listed = await near.call("threads.list");
  assert.ok(listed.threads.some((entry: Frame) => entry.id === name));
  assert.deepEqual(listed.machines.map((machine: Frame) => [machine.name, machine.reachable]), [["there", true], ["gone", false], ["locked", false]]);
  assert.match(listed.machines[1].error, /^Could not reach gone/);
});

test("portals link checks the other Mac and keeps it for the bridge to use at once; unlink forgets it", async (t) => {
  const third = await startTestBridge();
  const far = await TestClient.open(there);
  t.after(async () => {
    await far.close();
    await third.dispose();
  });
  const thread = await createThread(far);
  const links = pathsFor(third.home).links;
  const pairing = pairingLink({ url: there.url, user: username, password, name: "The Other Mac" });

  const linked = await run(["link", pairing], third.home);
  assert.equal(linked.code, 0, linked.stderr);
  assert.deepEqual(JSON.parse(linked.stdout).linked, { name: "the-other-mac", url: there.url });
  assert.equal(statSync(links).mode & 0o777, 0o600);
  assert.deepEqual(readLinks(links), [{ name: "the-other-mac", url: there.url, user: username, password }]);

  // The running bridge reads the file again: no restart.
  const machines = JSON.parse((await run(["machines"], third.home)).stdout).machines;
  assert.deepEqual(machines.map((machine: Frame) => [machine.name, machine.reachable]), [["the-other-mac", true]]);
  const threads = JSON.parse((await run(["threads"], third.home)).stdout).threads;
  assert.ok(threads.some((entry: Frame) => entry.id === `the-other-mac/${thread}`));
  const started = JSON.parse((await run(["start", "--machine", "the-other-mac", "--agent", "fake", "hello", "--wait"], third.home)).stdout);
  assert.equal(started.thread.machine, "the-other-mac");
  assert.equal(started.state, "idle");

  // The same Mac under another name replaces nothing; the same name replaces the link.
  assert.equal((await run(["link", pairing, "--name", "far"], third.home)).code, 0);
  assert.equal((await run(["link", pairing, "--name", "far"], third.home)).code, 0);
  assert.deepEqual(readLinks(links).map((link) => link.name), ["the-other-mac", "far"]);

  const unlinked = await run(["unlink", "far"], third.home);
  assert.deepEqual(JSON.parse(unlinked.stdout), { unlinked: "far" });
  assert.deepEqual(readLinks(links).map((link) => link.name), ["the-other-mac"]);
  assert.equal((await run(["unlink", "far"], third.home)).code, 1);

  // The pairing link can come in on the input, so it is in no shell history.
  const piped = await run(["link", "--name", "piped"], third.home, `${pairing}\n`);
  assert.equal(piped.code, 0, piped.stderr);
  assert.deepEqual(readLinks(links).map((link) => link.name), ["the-other-mac", "piped"]);
});

test("portals link keeps nothing when the other Mac does not take the sign-in or the link cannot be read", async (t) => {
  const third = await startTestBridge();
  t.after(() => third.dispose());
  const links = pathsFor(third.home).links;

  const elsewhere = await run(["link", pairingLink({ url: there.url.replace("127.0.0.1", "localhost."), user: username, password, name: "far" })], third.home);
  assert.match(JSON.parse(elsewhere.stderr).error.message, /it refused this address\. Its allowedHosts must name the address in the link/);
  const refused = await run(["link", pairingLink({ url: there.url, user: username, password: "wrong", name: "far" })], third.home);
  assert.equal(refused.code, 1);
  assert.match(JSON.parse(refused.stderr).error.message, /^Could not link far: it did not take the user name and password/);
  const down = await run(["link", pairingLink({ url: await deadAddress(), user: username, password, name: "far" })], third.home);
  assert.equal(down.code, 1);
  assert.match(JSON.parse(down.stderr).error.message, /^Could not link far: nothing answers at its address/);
  assert.equal((await run(["link", "not a link"], third.home)).code, 2);
  assert.deepEqual(readLinks(links), []);
});

test("a link another Mac is already linked under is not taken by a different Mac", async (t) => {
  const third = await startTestBridge();
  t.after(() => third.dispose());
  assert.equal((await run(["link", pairingLink({ url: there.url, user: username, password, name: "far" })], third.home)).code, 0);
  const other = await run(["link", pairingLink({ url: here.url, user: username, password, name: "far" })], third.home);
  assert.equal(other.code, 1);
  assert.match(JSON.parse(other.stderr).error.message, /There is already a linked Mac called far, at .*--name/);
  assert.deepEqual(readLinks(pathsFor(third.home).links).map((link) => link.url), [there.url]);
});

test("a link whose password the other Mac no longer takes asks it once, so its other clients are not locked out", async (t) => {
  const stale = await startTestBridge();
  const client = await TestClient.open(stale);
  t.after(async () => {
    await client.close();
    await stale.dispose();
  });
  writeLinks(pathsFor(stale.home).links, [linkTo(there, "there", { password: "an old one" })]);
  for (let count = 0; count < 12; count += 1) {
    const { machines } = await client.call("threads.list", {});
    assert.match(machines[0].error, /did not take the user name and password/);
  }
  // The person's phone still signs in over there.
  assert.equal((await signIn(there)).status, 200);
});

test("a Mac that does not answer is left out of listings for a moment, but asked again when a call names it", async (t) => {
  // It takes connections and drops them: no bridge answers there.
  let tries = 0;
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    tries += 1;
    sockets.push(socket);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const asleep = await startTestBridge();
  const client = await TestClient.open(asleep);
  t.after(async () => {
    await client.close();
    await asleep.dispose();
    await new Promise((resolve) => server.close(resolve));
  });
  writeLinks(pathsFor(asleep.home).links, [{ name: "asleep", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, user: username, password }]);

  const first = await client.call("threads.list", {});
  assert.equal(first.machines[0].reachable, false);
  const asked = tries;
  assert.ok(asked >= 1);
  for (let count = 0; count < 3; count += 1) assert.equal((await client.call("machines.list", {})).machines[0].reachable, false);
  assert.equal(tries, asked, "a listing asked the Mac again");
  await assert.rejects(client.call("thread.read", { thread: "asleep/some-thread" }), /Could not reach asleep/);
  assert.ok(tries > asked, "a call that names the Mac did not ask it");
});

test("a Mac left out of the listings is back in them once its bridge answers a call, also when the answer is a refusal", async (t) => {
  // The other bridge on a port of its own, so it comes back where the link points.
  const port = Number(new URL(await deadAddress()).port);
  let back = await startTestBridge({ keepHome: true, config: { port } });
  const near = await startTestBridge();
  writeLinks(pathsFor(near.home).links, [linkTo(back, "back")]);
  const client = await TestClient.open(near);
  t.after(async () => {
    await client.close();
    await near.dispose();
    await back.dispose();
    rmSync(back.home, { recursive: true, force: true });
  });
  const reachable = async () => (await client.call("machines.list", {})).machines.map((machine: Frame) => machine.reachable);

  // Stopped: a listing finds nothing there, and the next ones do not ask again for a moment.
  await back.dispose();
  assert.deepEqual(await reachable(), [false]);
  back = await startTestBridge({ home: back.home, keepHome: true });
  assert.deepEqual(await reachable(), [false]);
  // A call that names it is passed on, and its bridge answers: that it has no such thread.
  await assert.rejects(client.call("thread.read", { thread: "back/no-such-thread" }), (error: RpcFailure) => error.code === 4007 && /no thread no-such-thread/.test(error.message));
  assert.deepEqual(await reachable(), [true]);
});

test("a link signs in again after the other bridge restarts, and two Macs linked both ways each list the other once", async (t) => {
  // The other bridge on a port of its own, so it comes back where the link points.
  const port = Number(new URL(await deadAddress()).port);
  let back = await startTestBridge({ keepHome: true, config: { port } });
  const near = await startTestBridge();
  writeLinks(pathsFor(near.home).links, [linkTo(back, "back")]);
  writeLinks(pathsFor(back.home).links, [linkTo(near, "near")]);
  const client = await TestClient.open(near);
  t.after(async () => {
    await client.close();
    await near.dispose();
    await back.dispose();
    rmSync(back.home, { recursive: true, force: true });
  });
  const far = await TestClient.open(back);
  const thread = await createThread(far);
  await far.close();
  const mine = await createThread(client);

  const listed = (await client.call("threads.list", {})).threads.map((entry: Frame) => entry.id);
  assert.deepEqual(listed.filter((id: string) => id === `back/${thread}`), [`back/${thread}`]);
  assert.deepEqual(listed.filter((id: string) => id.endsWith(mine)), [mine], "this Mac's thread came back through the other");

  // Restarted, it knows no session of the link's: the link signs in again.
  await back.dispose();
  back = await startTestBridge({ home: back.home, keepHome: true });
  assert.equal((await client.call("thread.read", { thread: `back/${thread}` })).thread.id, `back/${thread}`);
});

