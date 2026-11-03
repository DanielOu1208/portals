import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createThread, startTestBridge, TestClient, type Frame } from "./helpers.ts";

// A thread on Mac B started from a thread on Mac A comes to rest while A's bridge cannot be
// reached (asleep, restarting, a network blip): its notice is tried again until A is back,
// since A's starter was told it need not poll (`tells_starter`; bug hunt round 4, BC2). Two
// bridges on this Mac stand in for two Macs, as in tell-starters-net.test.ts.

test("a notice to a starter on a Mac out of reach for a while is sent once that Mac is back, and once only", { timeout: 60_000 }, async () => {
  const a1 = await startTestBridge({ keepHome: true, config: { fleet: { name: "Mac A", tellStarters: true } } });
  const home = a1.home;
  const b = await startTestBridge({ config: { fleet: { name: "Mac B", tellStarters: true }, fake: { delayMs: 150 } }, noticeRetries: [200] });
  const toA1 = await TestClient.open(a1);
  const toB = await TestClient.open(b);
  let a2: Awaited<ReturnType<typeof startTestBridge>> | undefined;
  let toA2: TestClient | undefined;
  try {
    await toB.call("net.join_with", { link: (await toA1.call("net.invite")).link });
    let ends = Date.now() + 10_000;
    while (!(await toA1.call("machines.list")).machines?.some((mac: { name: string; reachable: boolean }) => mac.name === "mac-b" && mac.reachable)) {
      if (Date.now() > ends) throw new Error("A never reached B");
      await sleep(25);
    }
    const parent = await createThread(toA1);
    const started = await toA1.call("thread.start", { profile: "fake", machine: "mac-b", from: parent, text: "hello there friend" });
    assert.equal(started.tells_starter, true);
    const child = String(started.thread.id).split("/")[1];
    // A goes away while B's thread works.
    await toA1.close();
    await a1.close();
    let rest = await toB.call("thread.wait", { thread: child, timeout_ms: 2000 });
    for (let tries = 0; rest.state === "working" && tries < 10; tries += 1) rest = await toB.call("thread.wait", { thread: child, timeout_ms: 2000 });
    assert.equal(rest.state, "idle");
    // A few tries fail meanwhile.
    await sleep(700);
    // A comes back, on a new port: its entry is written anew and copied to B.
    a2 = await startTestBridge({ home, config: {} });
    toA2 = await TestClient.open(a2);
    const notices = async () =>
      ((await toA2!.call("thread.read", { thread: parent, last: 20 })).messages as Frame[]).map((m) => String(m.text)).filter((text) => text.includes("Notice from the bridge"));
    ends = Date.now() + 15_000;
    while ((await notices()).length === 0) {
      if (Date.now() > ends) assert.fail("A's starter was never told of B's thread");
      await sleep(50);
    }
    await sleep(800);
    const told = await notices();
    assert.equal(told.length, 1);
    assert.match(told[0], /finished its turn/);
  } finally {
    await toA2?.close();
    await toB.close();
    await a2?.close();
    await b.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a notice the starter's Mac took, whose answer was lost on the way, is not told twice when it is sent again", { timeout: 60_000 }, async () => {
  // Codex's review of the round 4 bridge fixes: a try sent again after a lost answer was taken as a new message.
  const a = await startTestBridge({ config: { fleet: { name: "Mac A", tellStarters: true } } });
  const b = await startTestBridge({ config: { fleet: { name: "Mac B", tellStarters: true }, fake: { delayMs: 150 } }, noticeRetries: [200] });
  const toA = await TestClient.open(a);
  const toB = await TestClient.open(b);
  try {
    await toB.call("net.join_with", { link: (await toA.call("net.invite")).link });
    const ends = Date.now() + 10_000;
    while (!(await toA.call("machines.list")).machines?.some((mac: { name: string; reachable: boolean }) => mac.name === "mac-b" && mac.reachable)) {
      if (Date.now() > ends) throw new Error("A never reached B");
      await sleep(25);
    }
    // B's first notice reaches A, but its answer does not come back to B.
    type Call = (name: string, method: string, params: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>;
    const links = (b.fleet as unknown as { links: { call: Call } }).links;
    const call = links.call.bind(links);
    let lost = false;
    links.call = async (name, method, params, ...rest) => {
      const answer = await call(name, method, params, ...rest);
      if (method === "thread.send" && !lost && String(params.text).includes("Notice from the bridge")) {
        lost = true;
        throw new Error("Could not reach mac-a: the connection closed");
      }
      return answer;
    };
    const parent = await createThread(toA);
    await toA.call("thread.start", { profile: "fake", machine: "mac-b", from: parent, text: "hello there friend" });
    const notices = async () =>
      ((await toA.call("thread.read", { thread: parent, last: 20 })).messages as Frame[]).map((m) => String(m.text)).filter((text) => text.includes("Notice from the bridge"));
    const until = Date.now() + 10_000;
    while (!lost || (await notices()).length === 0) {
      if (Date.now() > until) assert.fail("A's starter was never told");
      await sleep(50);
    }
    // Long enough for a try sent again.
    await sleep(1000);
    assert.equal((await notices()).length, 1);
  } finally {
    await toA.close();
    await toB.close();
    await a.dispose();
    await b.dispose();
  }
});

test("a notice whose answer was lost, its starter's bridge restarted before the next try, still reaches the starter (twice at most, never not at all)", { timeout: 60_000 }, async () => {
  // Codex's review of the round 4 bridge fixes: the ids a bridge took are known only while it
  // runs, since one kept on disk could answer for a notice the restart lost before its
  // starter had it. The try after the restart is taken again.
  const a1 = await startTestBridge({ keepHome: true, config: { fleet: { name: "Mac A", tellStarters: true } } });
  const home = a1.home;
  const b = await startTestBridge({ config: { fleet: { name: "Mac B", tellStarters: true }, fake: { delayMs: 150 } }, noticeRetries: [200] });
  const toA1 = await TestClient.open(a1);
  const toB = await TestClient.open(b);
  let a2: Awaited<ReturnType<typeof startTestBridge>> | undefined;
  let toA2: TestClient | undefined;
  try {
    await toB.call("net.join_with", { link: (await toA1.call("net.invite")).link });
    let ends = Date.now() + 10_000;
    while (!(await toA1.call("machines.list")).machines?.some((mac: { name: string; reachable: boolean }) => mac.name === "mac-b" && mac.reachable)) {
      if (Date.now() > ends) throw new Error("A never reached B");
      await sleep(25);
    }
    // B's first notice reaches A; A then stops before its answer gets back to B.
    type Call = (name: string, method: string, params: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>;
    const links = (b.fleet as unknown as { links: { call: Call } }).links;
    const call = links.call.bind(links);
    let lost = false;
    let takenAfterRestart = false;
    links.call = async (name, method, params, ...rest) => {
      const notice = method === "thread.send" && String(params.text).includes("Notice from the bridge");
      const answer = await call(name, method, params, ...rest);
      if (notice && !lost) {
        lost = true;
        await toA1.close();
        await a1.close();
        throw new Error("Could not reach mac-a: the connection closed");
      }
      if (notice && a2) takenAfterRestart = true;
      return answer;
    };
    const parent = await createThread(toA1);
    await toA1.call("thread.start", { profile: "fake", machine: "mac-b", from: parent, text: "hello there friend" });
    ends = Date.now() + 10_000;
    while (!lost) {
      if (Date.now() > ends) assert.fail("B's notice never reached A");
      await sleep(25);
    }
    a2 = await startTestBridge({ home, config: {} });
    toA2 = await TestClient.open(a2);
    ends = Date.now() + 15_000;
    while (!takenAfterRestart) {
      if (Date.now() > ends) assert.fail("B's next try never reached A once it was back");
      await sleep(50);
    }
    const reading = await toA2.call("thread.read", { thread: parent, last: 20 });
    const notices = (reading.messages as Frame[]).filter((m) => String(m.text).includes("Notice from the bridge"));
    // The fake agent kept the first before the restart, so the try after it is taken in as a
    // second: twice, as allowed, and not answered for by a record of the first, which a
    // starter that lost it in the restart would never have had.
    assert.equal(notices.length, 2);
  } finally {
    await toA2?.close();
    await toB.close();
    await a2?.close();
    await b.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
