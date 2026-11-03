import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToLoop, setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { methods, type CallContext } from "../src/gateway/methods.ts";
import { hashToken, Net } from "../src/net/net.ts";
import { startTestBridge, TestClient } from "./helpers.ts";

/** A peer whose answers can arrive after its membership changes, with no network. */
function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "portals-net-revocation-"));
  const calls: { params: Record<string, unknown>; answer: (reply: unknown) => void }[] = [];
  const net = new Net({
    path: join(home, "net.json"),
    ownPath: join(home, "net-own.json"),
    here: { id: "mac-alpha", name: "Alpha" },
    call: async (_link, _method, params) => new Promise((answer) => calls.push({ params, answer })),
  });
  t.after(() => {
    net.close();
    rmSync(home, { recursive: true, force: true });
  });
  net.start("http://alpha.test");
  const peer = { id: "mac-beta", kind: "mac", name: "Beta", url: "http://beta.test", token_hash: hashToken("b".repeat(43)) };
  const joinPeer = (token_hash = peer.token_hash) => net.join({ code: net.invite().code, member: { ...peer, token_hash } });
  joinPeer();
  const unexpected = { id: "phone-unexpected", kind: "device", name: "Unexpected", platform: "ios", token_hash: hashToken("p".repeat(43)), changed: Date.now(), by: peer.id };
  const reply = { net: net.revision().id, members: [unexpected] };
  return { net, peer, calls, joinPeer, reply };
}

test("a removed Mac is told it is out, but its answer cannot add a member", async (t) => {
  const { net, peer, calls, reply } = fixture(t);
  net.remove(peer.id, "mac-alpha");
  assert.equal(calls.length, 1, "the removed Mac is still told");
  assert.equal((calls[0].params.members as { id: string; removed?: boolean }[]).find((entry) => entry.id === peer.id)?.removed, true);
  const before = net.revision();
  calls[0].answer(reply);
  await yieldToLoop();
  assert.deepEqual(net.revision(), before, "an untrusted answer changes nothing");
  assert.equal(net.list(null).members.some((entry) => entry.id === "phone-unexpected"), false);
});

for (const change of ["removed", "retokened"] as const) {
  test(`a sync answer from before a Mac was ${change} cannot change the list`, async (t) => {
    const { net, peer, calls, joinPeer, reply } = fixture(t);
    const pulling = net.authenticate("u".repeat(43));
    assert.equal(calls.length, 1, "the old membership has an outstanding request");
    if (change === "removed") net.remove(peer.id, "mac-alpha");
    else joinPeer(hashToken("c".repeat(43)));
    const before = net.revision();
    calls[0].answer(reply);
    await pulling;
    assert.deepEqual(net.revision(), before, "the stale answer changes nothing");
    assert.equal(net.list(null).members.some((entry) => entry.id === "phone-unexpected"), false);
    for (const call of calls.slice(1)) call.answer({ net: reply.net, members: [] });
    await yieldToLoop();
  });
}

test("an answer under the Mac's current token still updates the list", async (t) => {
  const { net, calls, reply } = fixture(t);
  const pulling = net.authenticate("u".repeat(43));
  calls[0].answer(reply);
  await pulling;
  assert.equal(net.list(null).members.some((entry) => entry.id === "phone-unexpected"), true);
});

test("two scratch bridges: a removed peer's reply cannot admit another device", async (t) => {
  const a = await startTestBridge();
  t.after(() => a.dispose());
  const b = await startTestBridge();
  t.after(() => b.dispose());
  const owner = await TestClient.open(a);
  t.after(() => owner.close());
  const peer = await TestClient.open(b);
  t.after(() => peer.close());
  const bID = peer.readyPayload.bridge.machine.id as string;
  const joined = await peer.call("net.join_with", { link: (await owner.call("net.invite")).link });
  // Its initial sync must finish before the deliberate uncooperative reply below.
  await sleep(100);
  let replied = false;
  const original = methods["net.sync"].handle;
  t.mock.method(methods["net.sync"], "handle", (params: Record<string, unknown>, context: CallContext) => {
    const removing = (params.members as { id: string; removed?: boolean }[]).some((member) => member.id === bID && member.removed);
    if (context.gateway.machine !== bID || !removing) return original(params, context);
    // Only the removed bridge is uncooperative; the request and reply still cross
    // the real loopback HTTP/WebSocket transport under the net's actual tokens.
    replied = true;
    return { net: joined.net, members: [{ id: "phone-unexpected", kind: "device", name: "Unexpected", platform: "ios", token_hash: hashToken("p".repeat(43)), changed: Date.now(), by: bID }] };
  });
  await owner.call("net.remove", { member: bID });
  const until = Date.now() + 5000;
  while (!replied && Date.now() < until) await sleep(10);
  assert.equal(replied, true, "the removed bridge answered the actual removal notification");
  // Let the peer's reply traverse its socket and the receiving bridge's event loop.
  await sleep(100);
  const listed = await owner.call("net.list");
  assert.equal(listed.members.find((member: { id: string }) => member.id === bID).removed, true);
  assert.equal(listed.members.some((member: { id: string }) => member.id === "phone-unexpected"), false);
});
