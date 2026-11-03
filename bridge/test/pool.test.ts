import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { WarmPool, type Warmable } from "../src/providers/pool.ts";

// Which of an agent's processes stay running: idle ones stop after the idle time, and
// over the limit the least recently used idle one stops first. Busy ones never do.

class Stub implements Warmable {
  busy = false;
  cooled = 0;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async cool(): Promise<void> {
    this.cooled += 1;
  }
}

function pool(maxWarm: number, clock: { now: number }) {
  return new WarmPool({ maxWarm, idleMs: 15 * 60_000, now: () => clock.now });
}

test("an idle session cools after the idle time, not before", () => {
  const clock = { now: 0 };
  const warm = pool(6, clock);
  const session = new Stub("a");
  warm.warmed(session);
  warm.sweep(14 * 60_000);
  assert.equal(session.cooled, 0);
  warm.sweep(15 * 60_000);
  assert.equal(session.cooled, 1);
  assert.equal(warm.has(session), false);
});

test("using a session restarts its idle time", () => {
  const clock = { now: 0 };
  const warm = pool(6, clock);
  const session = new Stub("a");
  warm.warmed(session);
  clock.now = 10 * 60_000;
  warm.touch(session);
  warm.sweep(20 * 60_000);
  assert.equal(session.cooled, 0);
  warm.sweep(25 * 60_000);
  assert.equal(session.cooled, 1);
});

test("a busy session (a turn running, a question open) never cools, and its idle time starts when it is done", () => {
  const clock = { now: 0 };
  const warm = pool(6, clock);
  const session = new Stub("a");
  session.busy = true;
  warm.warmed(session);
  warm.sweep(60 * 60_000);
  assert.equal(session.cooled, 0);
  session.busy = false;
  warm.sweep(70 * 60_000);
  assert.equal(session.cooled, 0);
  warm.sweep(75 * 60_000);
  assert.equal(session.cooled, 1);
});

test("over the limit, the least recently used idle session cools first", () => {
  const clock = { now: 0 };
  const warm = pool(2, clock);
  const [a, b, c] = [new Stub("a"), new Stub("b"), new Stub("c")];
  warm.warmed(a);
  clock.now = 1;
  warm.warmed(b);
  clock.now = 2;
  warm.touch(a);
  clock.now = 3;
  warm.warmed(c);
  assert.deepEqual([a.cooled, b.cooled, c.cooled], [0, 1, 0]);
  assert.equal(warm.size, 2);
});

test("when every warm session is busy, the limit is passed rather than a turn cut short", () => {
  const clock = { now: 0 };
  const warm = pool(1, clock);
  const [a, b] = [new Stub("a"), new Stub("b")];
  a.busy = true;
  warm.warmed(a);
  warm.warmed(b);
  assert.equal(a.cooled, 0);
  assert.equal(warm.size, 2);
  // Once a is done, the next one to warm up pushes the older idle one out.
  a.busy = false;
  clock.now = 5;
  warm.touch(b);
  warm.warmed(new Stub("c"));
  assert.equal(a.cooled, 1);
  assert.equal(b.cooled, 1);
});

test("a session whose process went away leaves the pool", () => {
  const warm = pool(6, { now: 0 });
  const session = new Stub("a");
  warm.warmed(session);
  warm.cooled(session);
  warm.sweep(60 * 60_000);
  assert.equal(session.cooled, 0);
  assert.equal(warm.size, 0);
});

test("busy overflow shrinks to the limit once sessions become idle, oldest first", () => {
  const clock = { now: 0 };
  const warm = pool(2, clock);
  const sessions = [new Stub("a"), new Stub("b"), new Stub("c"), new Stub("d")];
  for (const session of sessions) {
    session.busy = true;
    warm.warmed(session);
    clock.now += 1;
  }
  warm.sweep(clock.now);
  assert.equal(warm.size, 4);
  for (const session of sessions) session.busy = false;
  // One is still needed, and the newest idle one was just used.
  sessions[0].busy = true;
  clock.now += 1;
  warm.touch(sessions[3]);
  warm.sweep(clock.now);
  assert.deepEqual(sessions.map((session) => session.cooled), [0, 1, 1, 0]);
  assert.equal(warm.size, 2);
});

test("an empty started pool has no sweep timer, and a drained pool stops its timer until a session warms again", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const warm = new WarmPool({ maxWarm: 6, idleMs: 4000, now: () => 0 });
  const sweeps = t.mock.method(warm, "sweep");
  warm.start();
  warm.start();
  t.mock.timers.tick(5000);
  assert.equal(sweeps.mock.callCount(), 0);
  const first = new Stub("first");
  warm.warmed(first);
  t.mock.timers.tick(1000);
  assert.equal(sweeps.mock.callCount(), 1);
  warm.cooled(first);
  t.mock.timers.tick(5000);
  assert.equal(sweeps.mock.callCount(), 1);
  warm.warmed(new Stub("second"));
  t.mock.timers.tick(1000);
  assert.equal(sweeps.mock.callCount(), 2);
  warm.sweep(4000);
  const drained = sweeps.mock.callCount();
  t.mock.timers.tick(5000);
  assert.equal(sweeps.mock.callCount(), drained);
  warm.stop();
});

test("a stopped pool schedules no sweeps when a session warms, and starts again with that session", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const warm = new WarmPool({ maxWarm: 6, idleMs: 4000, now: () => 0 });
  const sweeps = t.mock.method(warm, "sweep");
  warm.start();
  warm.stop();
  warm.warmed(new Stub("a"));
  t.mock.timers.tick(2000);
  assert.equal(sweeps.mock.callCount(), 0);
  warm.start();
  t.mock.timers.tick(1000);
  assert.equal(sweeps.mock.callCount(), 1);
  warm.stop();
  t.mock.timers.tick(5000);
  assert.equal(sweeps.mock.callCount(), 1);
});
