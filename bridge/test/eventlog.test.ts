import "./environment.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { EventLog } from "../src/sessions/eventLog.ts";

test("rebasing releases the old ring's payloads while keeping its replay boundary and numbering", () => {
  // Its own heap: GC here must not depend on when the test runner next collects.
  const module = new URL("../src/sessions/eventLog.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { EventLog } from ${JSON.stringify(module)};
    const log = new EventLog("s1", 3);
    function fill() {
      for (let n = 0; n < 4; n++) log.append("message.delta", { text: String(n) });
      const payload = { text: "only the log holds this" };
      log.append("message.delta", payload);
      return new WeakRef(payload);
    }
    const old = fill();
    const before = log.latestSeq;
    log.rebase();
    const base = log.base;
    assert.equal(base, before + 1);
    assert.deepEqual(log.since(before), { events: [], truncated: true, latestSeq: base });
    assert.deepEqual(log.since(base), { events: [], truncated: false, latestSeq: base });
    await new Promise(setImmediate);
    globalThis.gc();
    assert.equal(old.deref(), undefined, "no replay can reach the old payload");
    for (let n = 0; n < 4; n++) log.append("message.delta", { text: String(n) });
    assert.equal(log.since(base).truncated, true);
    assert.deepEqual(log.since(base + 1).events.map(event => event.seq), [base + 2, base + 3, base + 4]);
    log.rebase();
    assert.equal(log.append("message.start").seq, base + 6);
    assert.deepEqual(log.since(base + 5).events.map(event => event.seq), [base + 6]);
  `], { stdio: "pipe" });
});

test("events are numbered from 1, one by one, under their session", () => {
  const log = new EventLog("s1");
  assert.equal(log.latestSeq, 0);
  const first = log.append("message.start");
  const second = log.append("message.delta", { text: "Hi" });
  assert.deepEqual(first, { type: "message.start", session_id: "s1", seq: 1 });
  assert.deepEqual(second, { type: "message.delta", session_id: "s1", seq: 2, payload: { text: "Hi" } });
  assert.equal(log.latestSeq, 2);
});

test("since returns exactly the events after last_seen", () => {
  const log = new EventLog("s1");
  for (let index = 0; index < 5; index += 1) log.append("message.delta", { text: String(index) });
  assert.deepEqual(log.since(2).events.map((event) => event.seq), [3, 4, 5]);
  assert.equal(log.since(2).truncated, false);
  assert.deepEqual(log.since(0).events.map((event) => event.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(log.since(5), { events: [], truncated: false, latestSeq: 5 });
});

test("a log that no longer reaches back says it is truncated", () => {
  const log = new EventLog("s1", 3);
  for (let index = 0; index < 7; index += 1) log.append("message.delta", { text: String(index) });
  // Kept: 5, 6, 7.
  assert.deepEqual(log.since(4).events.map((event) => event.seq), [5, 6, 7]);
  assert.equal(log.since(4).truncated, false);
  assert.deepEqual(log.since(3), { events: [], truncated: true, latestSeq: 7 });
  assert.equal(log.since(0).truncated, true);
  assert.deepEqual(log.since(6).events.map((event) => event.seq), [7]);
});

test("numbers the log never gave out are treated as truncated", () => {
  const log = new EventLog("s1");
  log.append("message.start");
  assert.equal(log.since(9).truncated, true);
});

test("an empty log has nothing to replay", () => {
  assert.deepEqual(new EventLog("s1").since(0), { events: [], truncated: false, latestSeq: 0 });
});

test("progress retains only the latest in-flight snapshot without evicting ordinary replay events", () => {
  const log = new EventLog("s1", 4);
  const start = log.append("tool.start", { tool_id: "cmd" });
  log.append("tool.progress", { tool_id: "other", output: "other output" });
  for (let n = 0; n < 10_000; n++) log.append("tool.progress", { tool_id: "cmd", output: `latest ${n}` });
  const delta = log.append("message.delta", { text: "still kept" });
  let replay = log.since(0);
  assert.equal(replay.truncated, false);
  assert.deepEqual(replay.events.map((e) => e.seq), [start.seq, 2, delta.seq - 1, delta.seq]);
  assert.deepEqual(replay.events.filter((e) => e.type === "tool.progress").map((e) => e.payload?.output), ["other output", "latest 9999"]);
  const complete = log.append("tool.complete", { tool_id: "cmd", result: "full final result" });
  replay = log.since(0);
  assert.equal(replay.truncated, false, "intentional progress gaps do not require a snapshot");
  assert.deepEqual(replay.events.filter((e) => e.type === "tool.progress").map((e) => e.payload?.tool_id), ["other"]);
  assert.equal(replay.events.at(-1)?.seq, complete.seq);
  log.append("message.complete");
  assert.equal(log.since(0).events.filter((e) => e.type === "tool.progress").length, 0);
  log.append("message.start");
  assert.equal(log.since(0).truncated, true, "ordinary ring eviction still requires a snapshot");
});

test("the ring keeps order across many wraps", () => {
  const log = new EventLog("s1", 4);
  for (let index = 1; index <= 103; index += 1) log.append("message.delta", { text: String(index) });
  assert.deepEqual(log.since(99).events.map((event) => event.payload?.text), ["100", "101", "102", "103"]);
});

test("a log for a session loaded again numbers on past the last one, and replays nothing from before", () => {
  const log = new EventLog("s1", 5000, 41);
  // 42 is held back: no event has it, and a snapshot taken now holds it.
  assert.equal(log.latestSeq, 42);
  // A device that holds a number of the session before takes a snapshot.
  assert.deepEqual(log.since(41), { events: [], truncated: true, latestSeq: 42 });
  assert.equal(log.since(30).truncated, true);
  assert.equal(log.since(0).truncated, true);
  // One that took a snapshot of this one has missed nothing.
  assert.deepEqual(log.since(42), { events: [], truncated: false, latestSeq: 42 });
  assert.equal(log.append("message.start").seq, 43);
  assert.deepEqual(log.since(42).events.map((event) => event.seq), [43]);
  assert.equal(log.since(41).truncated, true);
});

test("a session loaded again after one that gave out nothing still replays nothing from before", () => {
  const log = new EventLog("s1", 5000, 0);
  assert.equal(log.latestSeq, 1);
  assert.equal(log.since(0).truncated, true);
  assert.deepEqual(log.since(1), { events: [], truncated: false, latestSeq: 1 });
});

test("the base holds once the ring has wrapped", () => {
  const log = new EventLog("s1", 3, 10);
  for (let index = 0; index < 5; index += 1) log.append("message.delta", { text: String(index) });
  // 11 held back; 12 to 16 given out; 14, 15, 16 kept.
  assert.deepEqual(log.since(13).events.map((event) => event.seq), [14, 15, 16]);
  assert.equal(log.since(12).truncated, true);
});

test("a log moved on past a change no event told of replays nothing from before it", () => {
  const log = new EventLog("s1");
  for (let index = 0; index < 3; index += 1) log.append("message.delta", { text: String(index) });
  log.rebase();
  // 4 is held back, as at a base the log began with: a snapshot taken now holds it.
  assert.equal(log.latestSeq, 4);
  assert.deepEqual(log.since(3), { events: [], truncated: true, latestSeq: 4 });
  assert.equal(log.since(1).truncated, true);
  assert.deepEqual(log.since(4), { events: [], truncated: false, latestSeq: 4 });
  assert.equal(log.append("message.delta").seq, 5);
  assert.deepEqual(log.since(4).events.map((event) => event.seq), [5]);
  assert.equal(log.since(3).truncated, true);
});
