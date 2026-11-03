import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { parseConfig, pathsFor } from "../src/config.ts";
import { pollNowWaitMs } from "../src/gateway/pollNow.ts";
import { checkEveryMs, compareVersions, isNewer, registryURL, UpdateCheck, type UpdateCheckOptions } from "../src/updates.ts";
import { version } from "../src/version.ts";
import { isEvent, startTestBridge, TestClient } from "./helpers.ts";

// Whether a later portals-host is out (feature update_notice, src/updates.ts): asked of
// npm's registry as the bridge starts and about once a day after, never more often, across
// restarts too; nothing said when offline or on any error; told to devices in
// gateway.ready, the sessions.activity answer and poll.now; never asked with
// `updates.check` off.

const day = checkEveryMs;
const hour = 60 * 60 * 1000;

test("versions are ordered as semver orders them", () => {
  const ordered = ["0.2.0", "0.2.1", "0.3.0-alpha", "0.3.0-alpha.1", "0.3.0-alpha.beta", "0.3.0-beta", "0.3.0-beta.2", "0.3.0-beta.11", "0.3.0-rc.1", "0.3.0", "0.3.1", "0.10.0", "1.0.0", "10.0.0"];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} against ${ordered[j]}`);
    }
  }
  // Build metadata, a leading v and spaces around it make no difference.
  assert.equal(compareVersions("0.3.0+build.5", "0.3.0"), 0);
  assert.equal(compareVersions("v0.3.1", " 0.3.0 "), 1);
  // Numbers past what a double holds exactly are still compared exactly.
  assert.equal(compareVersions("0.3.9007199254740993", "0.3.9007199254740992"), 1);
  for (const odd of ["", "0.3", "0.3.0.1", "latest", "01.0.0", "0.3.0-", "0.3.x", "1.0.0-beta..1"]) {
    assert.equal(compareVersions(odd, "0.3.0"), undefined, odd);
    assert.equal(compareVersions("0.3.0", odd), undefined, odd);
  }
  assert.equal(isNewer("0.3.1", "0.3.0"), true);
  assert.equal(isNewer("0.3.0", "0.3.0"), false);
  assert.equal(isNewer("0.2.9", "0.3.0"), false);
  assert.equal(isNewer("0.3.0", "0.3.0-beta.1"), true);
  assert.equal(isNewer("not a version", "0.3.0"), false);
  assert.equal(isNewer("0.3.1", "a copy from git"), false);
});

/** A registry that answers each ask with what `answer` gives, counting them. */
function fakeRegistry(answer: () => Response | Promise<Response>) {
  const asked: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return answer();
  }) as typeof globalThis.fetch;
  return { asked, fetch };
}

const answering = (version: unknown) => () => Response.json({ name: "portals-host", version, description: "…" });

/** A check with a clock and timers of the test's, its file in a folder of its own. */
function checker(t: TestContext, options: Partial<UpdateCheckOptions> & { fetch: typeof fetch }) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const folder = mkdtempSync(join(tmpdir(), "portals-updates-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const clock = { now: Date.parse("2026-10-29T12:00:00Z") };
  const changed: (string | undefined)[] = [];
  const file = join(folder, "update.json");
  const check: UpdateCheck = new UpdateCheck({ own: "0.3.0", file, now: () => clock.now, changed: () => changed.push(check.latest), ...options });
  t.after(() => check.stop());
  /** Moves the clock and the timers on, and waits for an ask that started to end. */
  const pass = async (ms: number) => {
    clock.now += ms;
    t.mock.timers.tick(ms);
    await check.settled;
  };
  return { check, clock, changed, file, pass };
}

test("the registry is asked as the bridge starts, then once a day, never more often", async (t) => {
  const registry = fakeRegistry(answering("0.3.0"));
  const { check, clock, file, pass } = checker(t, { fetch: registry.fetch });
  check.start();
  await check.settled;
  assert.deepEqual(registry.asked, [registryURL]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { checked: new Date(clock.now).toISOString(), latest: "0.3.0" });
  assert.equal(check.latest, undefined, "the same version is no update");

  await pass(day - 1);
  assert.equal(registry.asked.length, 1, "not before the day is over");
  await pass(1);
  assert.equal(registry.asked.length, 2);
  await pass(day);
  assert.equal(registry.asked.length, 3);
});

test("a bridge started again within the day does not ask: it takes what was found, and asks once the day is over", async (t) => {
  const registry = fakeRegistry(answering("0.3.2"));
  const { check, clock, file, pass } = checker(t, { fetch: registry.fetch });
  writeFileSync(file, JSON.stringify({ checked: new Date(clock.now - 5 * hour).toISOString(), latest: "0.3.1" }));
  check.start();
  await check.settled;
  assert.deepEqual(registry.asked, []);
  assert.equal(check.latest, "0.3.1", "known at once, from the last check");

  await pass(19 * hour - 1);
  assert.deepEqual(registry.asked, []);
  await pass(1);
  assert.equal(registry.asked.length, 1);
  assert.equal(check.latest, "0.3.2");
  await pass(day - 1);
  assert.equal(registry.asked.length, 1);
});

test("a bridge that stops while it asks, again and again, still asks once a day", async (t) => {
  // The ask never ends: each bridge is stopped first.
  const registry = fakeRegistry(() => new Promise<Response>(() => {}));
  const folder = mkdtempSync(join(tmpdir(), "portals-updates-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "update.json");
  let now = Date.parse("2026-10-29T12:00:00Z");
  for (let start = 0; start < 5; start++) {
    const check = new UpdateCheck({ own: "0.3.0", file, now: () => now, fetch: registry.fetch });
    check.start();
    check.stop();
    now += 10 * 60 * 1000;
  }
  assert.equal(registry.asked.length, 1);
});

test("a check said to be in the future (the clock was set back) is taken as one made now, also by the next start", async (t) => {
  const registry = fakeRegistry(answering("0.3.1"));
  const { check, clock, file, pass } = checker(t, { fetch: registry.fetch });
  writeFileSync(file, JSON.stringify({ checked: new Date(clock.now + 30 * day).toISOString(), latest: null }));
  check.start();
  await check.settled;
  assert.deepEqual(registry.asked, []);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).checked, new Date(clock.now).toISOString(), "kept as made now");
  await pass(day - 1);
  assert.deepEqual(registry.asked, []);
  await pass(1);
  assert.equal(registry.asked.length, 1);
  assert.equal(check.latest, "0.3.1");

  // Started again every six hours from a clock set back: the day is not put off each time.
  writeFileSync(file, JSON.stringify({ checked: new Date(clock.now + 30 * day).toISOString(), latest: "0.3.1" }));
  check.stop();
  let now = clock.now;
  for (let start = 0; start < 5; start++) {
    const again = new UpdateCheck({ own: "0.3.0", file, now: () => now, fetch: registry.fetch });
    again.start();
    await again.settled;
    again.stop();
    now += 6 * hour;
  }
  assert.equal(registry.asked.length, 2, "asked again once the day since the first start was over");
});

test("a bridge that cannot keep when it asked does not ask as it starts, only once it has run a day", async (t) => {
  const registry = fakeRegistry(answering("0.3.1"));
  const { check, clock, file, pass } = checker(t, { fetch: registry.fetch });
  // A folder where the file goes: it can be neither read nor written.
  mkdirSync(file);
  for (let start = 0; start < 4; start++) {
    const again = new UpdateCheck({ own: "0.3.0", file, now: () => clock.now, fetch: registry.fetch });
    again.start();
    await again.settled;
    again.stop();
  }
  assert.deepEqual(registry.asked, []);
  check.start();
  await pass(day - 1);
  assert.deepEqual(registry.asked, []);
  await pass(1);
  assert.equal(registry.asked.length, 1);
  assert.equal(check.latest, "0.3.1");
  await pass(day);
  assert.equal(registry.asked.length, 2);
});

test("a file that cannot be used is a bridge that never asked", async (t) => {
  for (const kept of ["not JSON", "null", "3", JSON.stringify("0.3.1"), JSON.stringify({ checked: "yesterday", latest: "soon" }), JSON.stringify({ checked: 5, latest: 6 }), JSON.stringify([1, 2])]) {
    const registry = fakeRegistry(answering("0.3.0"));
    const { check, file } = checker(t, { fetch: registry.fetch });
    writeFileSync(file, kept);
    check.start();
    await check.settled;
    assert.equal(registry.asked.length, 1, kept);
    assert.equal(check.latest, undefined, kept);
    check.stop();
    t.mock.timers.reset();
  }
});

test("offline, or on any error, nothing is said and the registry is asked again a day later, not sooner", async (t) => {
  const answers: (() => Response | Promise<Response>)[] = [
    () => Promise.reject(new TypeError("fetch failed")),
    () => new Response("Service Unavailable", { status: 503 }),
    () => new Response("<html>a captive portal</html>", { status: 200 }),
    () => Response.json({ name: "portals-host" }),
    () => Response.json({ version: "latest" }),
    () => Response.json(null),
    () => new Response("x".repeat(2 * 1024 * 1024)),
  ];
  let next = 0;
  const registry = fakeRegistry(() => answers[next++]());
  const { check, file, changed, pass } = checker(t, { fetch: registry.fetch });
  check.start();
  await check.settled;
  for (let ask = 1; ask < answers.length; ask++) {
    assert.equal(check.latest, undefined);
    await pass(day - 1);
    assert.equal(registry.asked.length, ask, "not sooner than a day");
    await pass(1);
  }
  assert.equal(registry.asked.length, answers.length);
  assert.equal(check.latest, undefined);
  assert.deepEqual(changed, []);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).latest, null);
});

test("an answer that does not come in time is given up until the next day", async (t) => {
  const registry = fakeRegistry(() => new Promise<Response>(() => {}));
  const folder = mkdtempSync(join(tmpdir(), "portals-updates-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // The fake never answers, so the fetch it stands for is given the signal to watch.
  const fetch = ((url: string | URL | Request, init?: RequestInit) => {
    void registry.fetch(url, init);
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as typeof globalThis.fetch;
  const check = new UpdateCheck({ own: "0.3.0", file: join(folder, "update.json"), fetch, answerMs: 20 });
  t.after(() => check.stop());
  // Its timers are unref'd, so something else keeps the loop alive until they fire.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  check.start();
  await check.settled;
  assert.equal(registry.asked.length, 1);
  assert.equal(check.latest, undefined);
});

test("a later version is told once as it comes, and no longer once this bridge has it", async (t) => {
  const versions = ["0.3.1", "0.3.1", "0.4.0", "0.2.0"];
  const registry = fakeRegistry(() => answering(versions.shift())());
  const { check, changed, pass } = checker(t, { fetch: registry.fetch });
  check.start();
  await check.settled;
  assert.equal(check.latest, "0.3.1");
  await pass(day);
  assert.equal(check.latest, "0.3.1");
  await pass(day);
  assert.equal(check.latest, "0.4.0");
  // The registry's latest moved back (a release taken back): there is none later.
  await pass(day);
  assert.equal(check.latest, undefined);
  assert.deepEqual(changed, ["0.3.1", "0.4.0", undefined]);
});

test("updates.check is on unless config.json turns it off", () => {
  assert.deepEqual(parseConfig({}).updates, { check: true });
  assert.deepEqual(parseConfig({ updates: { check: false } }).updates, { check: false });
  assert.throws(() => parseConfig({ updates: { check: "no" } }), /updates.check must be true or false/);
  assert.throws(() => parseConfig({ updates: false }), /updates must be an object/);
});

test("devices are told of a later version: in gateway.ready, the sessions.activity answer and poll.now as it comes", async (t) => {
  let release!: () => void;
  const answered = new Promise<void>((resolve) => (release = resolve));
  const registry = fakeRegistry(async () => {
    await answered;
    return answering("99.0.0")();
  });
  const bridge = await startTestBridge({ config: { updates: { check: true } }, updates: { fetch: registry.fetch } });
  const before = await TestClient.open(bridge, { capabilities: { poll_now: true } });
  t.after(async () => {
    await before.close();
    await bridge.dispose();
  });
  assert.ok(before.readyPayload.bridge.features.includes("update_notice"));
  assert.equal(before.readyPayload.bridge.version, version);
  assert.equal("latest" in before.readyPayload.bridge, false, "none yet");
  assert.equal("latest" in (await before.call("sessions.activity")), false);

  release();
  await bridge.updates!.settled;
  assert.deepEqual(registry.asked, [registryURL]);
  await before.next((frame) => isEvent(frame, "poll.now"), pollNowWaitMs + 2000);
  assert.equal((await before.call("sessions.activity")).latest, "99.0.0");
  const after = await TestClient.open(bridge);
  t.after(() => after.close());
  assert.equal(after.readyPayload.bridge.latest, "99.0.0");
  assert.deepEqual(JSON.parse(readFileSync(pathsFor(bridge.home).update, "utf8")).latest, "99.0.0");
});

test("with updates.check off the registry is never asked and nothing is said", async (t) => {
  const registry = fakeRegistry(answering("99.0.0"));
  const bridge = await startTestBridge({ config: { updates: { check: false } }, updates: { fetch: registry.fetch } });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  await sleep(50);
  assert.equal(bridge.updates, undefined);
  assert.deepEqual(registry.asked, []);
  assert.ok(client.readyPayload.bridge.features.includes("update_notice"));
  assert.equal("latest" in client.readyPayload.bridge, false);
  assert.equal("latest" in (await client.call("sessions.activity")), false);
  assert.equal(existsSync(pathsFor(bridge.home).update), false);
});
