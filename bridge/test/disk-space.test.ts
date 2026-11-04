import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { pathsFor } from "../src/config.ts";
import { diskLevel, DiskSpace, outOfSpace, readEveryMs, type DiskSpaceOptions } from "../src/disk.ts";
import { pollNowWaitMs } from "../src/gateway/pollNow.ts";
import { createThread, failingWrites, isEvent, runTurn, startTestBridge, TestClient, type Frame } from "./helpers.ts";

// The free space on the bridge's disk (feature disk_space, src/disk.ts): read as the bridge
// starts and every five minutes, never per event; told to devices in gateway.ready, the
// sessions.activity answer and poll.now; and as it runs low, told once in each thread at
// work and each that starts a turn. A write of a thread's that fails for want of space is
// told in that thread, once.

const gigabyte = 1_000_000_000;

/** A volume of `total` bytes with `free` of them free, as `statfs` gives it, which a test changes as it goes. */
function volume(free: number, total = 500 * gigabyte) {
  const disk = { free, total, reads: 0, fails: false };
  const statfs: NonNullable<DiskSpaceOptions["statfs"]> = async () => {
    disk.reads += 1;
    if (disk.fails) throw new Error("ENOENT: no such file or directory, statfs");
    return { bsize: 1000, blocks: BigInt(Math.floor(disk.total / 1000)), bavail: BigInt(Math.floor(disk.free / 1000)) };
  };
  return Object.assign(disk, { statfs });
}

/** A watch on `disk` with the test's timers and clock, and what it told. */
function watching(t: TestContext, disk: ReturnType<typeof volume>) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-03T12:00:00Z") });
  const told = { changed: 0, low: 0 };
  const space = new DiskSpace({ path: "/", name: () => "Studio", statfs: disk.statfs, changed: () => (told.changed += 1), low: () => (told.low += 1) });
  t.after(() => space.stop());
  const pass = async (ms: number) => {
    t.mock.timers.tick(ms);
    await space.settled;
  };
  return { space, told, pass };
}

test("the disk is low under 5 GB free and critical under 1 GB, or under a tenth and a fiftieth of a small volume", () => {
  assert.equal(diskLevel(200 * gigabyte, 500 * gigabyte), "ok");
  assert.equal(diskLevel(5 * gigabyte, 500 * gigabyte), "ok");
  assert.equal(diskLevel(4.9 * gigabyte, 500 * gigabyte), "low");
  assert.equal(diskLevel(1 * gigabyte, 500 * gigabyte), "low");
  assert.equal(diskLevel(0.9 * gigabyte, 500 * gigabyte), "critical");
  assert.equal(diskLevel(0, 500 * gigabyte), "critical");
  // A 32 GB card: 4 GB free is an eighth of it, room enough.
  assert.equal(diskLevel(4 * gigabyte, 32 * gigabyte), "ok");
  assert.equal(diskLevel(3 * gigabyte, 32 * gigabyte), "low");
  assert.equal(diskLevel(0.6 * gigabyte, 32 * gigabyte), "critical");
});

test("a write refused for want of space is a full disk or a used-up quota, nothing else", () => {
  assert.equal(outOfSpace(Object.assign(new Error("no space left on device"), { code: "ENOSPC" })), true);
  assert.equal(outOfSpace(Object.assign(new Error("disk quota exceeded"), { code: "EDQUOT" })), true);
  for (const error of [Object.assign(new Error("permission denied"), { code: "EACCES" }), new Error("no space left on device"), null, undefined, "ENOSPC"]) {
    assert.equal(outOfSpace(error), false, String(error));
  }
});

test("the disk is read as the bridge starts and every five minutes after; devices are told as the level changes, or the free space by a quarter of a gigabyte", async (t) => {
  const disk = volume(200 * gigabyte);
  const { space, told, pass } = watching(t, disk);
  assert.equal(space.now === undefined, true, "not read yet");
  space.start();
  await space.settled;
  assert.deepEqual(space.now, { free: 200 * gigabyte, total: 500 * gigabyte, level: "ok" });
  assert.deepEqual([disk.reads, told.changed], [1, 1]);
  disk.free -= 0.1 * gigabyte;
  await pass(readEveryMs - 1);
  assert.equal(disk.reads, 1);
  await pass(1);
  // Read again, but too little moved to tell; told once it adds up.
  assert.deepEqual([disk.reads, told.changed, space.now?.free], [2, 1, 199.9 * gigabyte]);
  disk.free -= 0.2 * gigabyte;
  await pass(readEveryMs);
  assert.deepEqual([disk.reads, told.changed], [3, 2]);
  // A disk that cannot be read says nothing new, and is read again on time.
  disk.fails = true;
  await pass(readEveryMs);
  assert.deepEqual([disk.reads, told.changed, space.now?.level], [4, 2, "ok"]);
  disk.fails = false;
  space.stop();
  await pass(readEveryMs * 3);
  assert.equal(disk.reads, 4, "stopped, it reads no more");
});

test("a spell of low space begins once as the disk runs low, lasts while it is critical, and ends only with room again", async (t) => {
  const disk = volume(200 * gigabyte);
  const { space, told, pass } = watching(t, disk);
  space.start();
  await space.settled;
  assert.deepEqual([space.lowSpell, told.low], [undefined, 0]);
  disk.free = 4 * gigabyte;
  await pass(readEveryMs);
  assert.deepEqual([space.now?.level, space.lowSpell, told.low], ["low", 1, 1]);
  disk.free = 0.5 * gigabyte;
  await pass(readEveryMs);
  assert.deepEqual([space.now?.level, space.lowSpell, told.low], ["critical", 1, 1]);
  // Just over the low mark: not low, though the spell goes on, so a disk near the mark does not tell again and again.
  disk.free = 5.5 * gigabyte;
  await pass(readEveryMs);
  assert.deepEqual([space.now?.level, space.lowSpell, told.low], ["ok", undefined, 1]);
  disk.free = 4.5 * gigabyte;
  await pass(readEveryMs);
  assert.deepEqual([space.lowSpell, told.low], [1, 1]);
  // Room again: the next time it runs low is another spell.
  disk.free = 6 * gigabyte;
  await pass(readEveryMs);
  disk.free = 3 * gigabyte;
  await pass(readEveryMs);
  assert.deepEqual([space.lowSpell, told.low], [2, 2]);
});

test("a write that fails for want of space has the disk read again at once, no more than once in ten seconds", async (t) => {
  const disk = volume(200 * gigabyte);
  const { space, pass } = watching(t, disk);
  space.start();
  await space.settled;
  const full = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  disk.free = 0;
  await pass(10_000);
  assert.equal(space.outOfSpace(full), true);
  await space.settled;
  assert.deepEqual([disk.reads, space.now?.level], [2, "critical"]);
  assert.equal(space.outOfSpace(full), true);
  assert.equal(space.outOfSpace(Object.assign(new Error("permission denied"), { code: "EACCES" })), false);
  await space.settled;
  assert.equal(disk.reads, 2);
  // The next reading is a full reading's time after the last.
  await pass(readEveryMs - 1);
  assert.equal(disk.reads, 2);
  await pass(1);
  assert.equal(disk.reads, 3);
});

/** The warning notices among `events`. */
function warnings(events: Frame[]): string[] {
  return events.filter((event) => event.type === "status.update" && event.payload.kind === "warn").map((event) => event.payload.text);
}

const almostFull = "Studio is almost out of disk space. Agents may fail and history may not be saved until space is freed.";

test("devices are told the free space: in gateway.ready, the sessions.activity answer and poll.now as it changes", async (t) => {
  const disk = volume(200 * gigabyte);
  const bridge = await startTestBridge({ config: { fleet: { name: "Studio" } }, disk: { statfs: disk.statfs } });
  await bridge.disk.settled;
  const client = await TestClient.open(bridge, { capabilities: { poll_now: true } });
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  assert.ok(client.readyPayload.bridge.features.includes("disk_space"));
  assert.deepEqual(client.readyPayload.bridge.disk, { free: 200 * gigabyte, total: 500 * gigabyte, level: "ok" });
  assert.deepEqual((await client.call("sessions.activity")).disk, { free: 200 * gigabyte, total: 500 * gigabyte, level: "ok" });

  const start = client.frames.length;
  disk.free = 3 * gigabyte;
  await bridge.disk.read();
  await client.from(start, (frame) => isEvent(frame, "poll.now"), pollNowWaitMs + 2000);
  assert.deepEqual((await client.call("sessions.activity")).disk, { free: 3 * gigabyte, total: 500 * gigabyte, level: "low" });
});

test("as space runs low, a thread at work is told once, a thread that starts a turn once, and each again only in the next spell", async (t) => {
  const disk = volume(200 * gigabyte);
  const bridge = await startTestBridge({ config: { fleet: { name: "Studio" } }, disk: { statfs: disk.statfs } });
  await bridge.disk.settled;
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const working = await createThread(client);
  const resting = await createThread(client);
  assert.deepEqual(warnings(await runTurn(client, resting, "hello")), []);

  const before = client.events(working).length;
  const restingBefore = client.events(resting).length;
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: working, text: "slowly please", profile: "fake" });
  await client.from(start, (frame) => isEvent(frame, "message.delta", working));
  disk.free = 3 * gigabyte;
  await bridge.disk.read();
  // Read again while still low: nothing more.
  disk.free = 2 * gigabyte;
  await bridge.disk.read();
  await client.from(start, (frame) => isEvent(frame, "message.complete", working), 10_000);
  assert.deepEqual(warnings(client.events(working).slice(before)), [almostFull]);
  assert.deepEqual(warnings(client.events(resting).slice(restingBefore)), [], "a thread at rest is not told yet");

  // At its next turn, after the turn's start.
  const next = await runTurn(client, resting, "hello");
  assert.deepEqual(warnings(next), [almostFull]);
  assert.ok(next.findIndex((event) => event.type === "status.update") > next.findIndex((event) => event.type === "message.start"));
  assert.deepEqual(warnings(await runTurn(client, resting, "hello")), []);
  assert.deepEqual(warnings(await runTurn(client, working, "hello")), []);

  // Room again, then low again: told again.
  disk.free = 50 * gigabyte;
  await bridge.disk.read();
  assert.deepEqual(warnings(await runTurn(client, resting, "hello")), []);
  disk.free = 1 * gigabyte;
  await bridge.disk.read();
  assert.deepEqual(warnings(await runTurn(client, resting, "hello")), [almostFull]);
});

test("a thread whose record cannot be written for a full disk is told once, until a turn's write works again", async (t) => {
  const disk = volume(200 * gigabyte);
  const bridge = await startTestBridge({ config: { fleet: { name: "Studio" } }, disk: { statfs: disk.statfs } });
  await bridge.disk.settled;
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const session = await createThread(client);
  const full = "Studio is out of disk space, so this thread could not be fully saved. Agents may fail until space is freed.";
  // The disk filled between two readings.
  disk.free = 0;
  const restore = failingWrites(t, pathsFor(bridge.home).threads);
  // Its start and its end are not written: told once, and the low notice, which says as much, not besides.
  const failed = await runTurn(client, session, "hello");
  assert.deepEqual(warnings(failed), [full]);
  assert.equal(failed.at(-1).payload.status, "complete", "the turn goes on all the same");
  assert.deepEqual(warnings(await runTurn(client, session, "hello")), []);

  // Space freed: the next turn's writes work, and a later failure is told again.
  restore();
  disk.free = 100 * gigabyte;
  await bridge.disk.read();
  assert.deepEqual(warnings(await runTurn(client, session, "hello")), []);
  const again = failingWrites(t, pathsFor(bridge.home).threads);
  assert.deepEqual(warnings(await runTurn(client, session, "hello")), [full]);
  again();
});
