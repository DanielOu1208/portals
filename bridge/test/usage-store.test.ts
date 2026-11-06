import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import type { ReadRequest } from "../src/usage/readers/common.ts";
import type { Cursor, ScanMessage } from "../src/usage/scanner.ts";
import { Calendar, UsageStore } from "../src/usage/store.ts";

// The daily totals (src/usage/store.ts): requests added to the host's own days and hours,
// in its time zone; a file's earlier counts replaced; everything saved in one file and
// loaded again.

setLogLevel("silent");

function request(at: string, input: number, output: number, extra: Partial<ReadRequest> = {}): ReadRequest {
  return { agent: "claude", session: "s1", at: Date.parse(at), model: "claude-opus-5-5", folder: "/Users/dana/code/app", input, output, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, requests: 1, ...extra };
}

function cursor(id: number): Cursor {
  return { id, agent: "claude", kind: "append", dev: 1, ino: id, size: 10, mtime: 1, offset: 10 };
}

function file(path: string, id: number, requests: ReadRequest[], replace = false, takeover: string[] = []): ScanMessage {
  return { type: "file", path, cursor: cursor(id), requests, replace, takeover };
}

const folder = () => mkdtempSync(join(tmpdir(), "portals-usage-store-"));

test("a moment's day and hour are the host's own, in its time zone, across a change of the clocks and odd offsets", () => {
  const late = Date.parse("2026-11-05T23:30:00Z");
  assert.deepEqual(new Calendar("America/Vancouver").at(late), ["2026-11-05", 15]);
  assert.deepEqual(new Calendar("Asia/Tokyo").at(late), ["2026-11-06", 8]);
  assert.deepEqual(new Calendar("Europe/London").at(late), ["2026-11-05", 23]);
  assert.deepEqual(new Calendar("Asia/Kathmandu").at(Date.parse("2026-11-05T18:20:00Z")), ["2026-11-06", 0]);
  // London's clocks go back at 01:00 UTC on 2026-10-25: 01:30 twice, an hour apart.
  const london = new Calendar("Europe/London");
  assert.deepEqual(london.at(Date.parse("2026-10-25T00:30:00Z")), ["2026-10-25", 1]);
  assert.deepEqual(london.at(Date.parse("2026-10-25T01:30:00Z")), ["2026-10-25", 1]);
  assert.deepEqual(london.at(Date.parse("2026-10-24T23:30:00Z")), ["2026-10-25", 0]);
  assert.equal(new Calendar("Not/A_Zone").timeZone.length > 0, true);
});

test("requests go to the day and hour of the host's time zone, by agent, model, folder and via", () => {
  const tokyo = new UsageStore(folder(), { timeZone: "Asia/Tokyo" });
  const vancouver = new UsageStore(folder(), { timeZone: "America/Vancouver" });
  const requests = [request("2026-11-05T23:30:00Z", 10, 100), request("2026-11-05T23:45:00Z", 1, 2, { model: "claude-haiku-5-5" }), request("2026-11-06T02:00:00Z", 5, 50, { session: "s2" })];
  const via = (one: ReadRequest) => (one.session === "s2" ? "portals" : "elsewhere");
  for (const store of [tokyo, vancouver]) store.apply(file("/a.jsonl", 1, requests), via);
  assert.deepEqual(
    tokyo.dayRows("2026-11-01", "2026-11-30").map((row) => [row.day, row.model, row.via, row.input, row.output, row.requests]),
    [["2026-11-06", "claude-opus-5-5", "elsewhere", 10, 100, 1], ["2026-11-06", "claude-haiku-5-5", "elsewhere", 1, 2, 1], ["2026-11-06", "claude-opus-5-5", "portals", 5, 50, 1]],
  );
  assert.deepEqual(vancouver.dayRows("2026-11-05", "2026-11-05").map((row) => [row.day, row.via, row.input]), [["2026-11-05", "elsewhere", 10], ["2026-11-05", "elsewhere", 1], ["2026-11-05", "portals", 5]]);
  assert.deepEqual(vancouver.dayRows("2026-11-04", "2026-11-04"), []);
  const hours = tokyo.hourRowsBetween("2026-11-06", "2026-11-06");
  const elsewhere = hours.find((row) => row.via === "elsewhere")!;
  assert.equal(elsewhere.tokens.length, 24);
  assert.equal(elsewhere.tokens[8], 113);
  assert.equal(hours.find((row) => row.via === "portals")!.tokens[11], 55);
  assert.equal(vancouver.hourRowsBetween("2026-11-05", "2026-11-05").find((row) => row.via === "elsewhere")!.tokens[15], 113);
  assert.equal(vancouver.hourRowsBetween("2026-11-05", "2026-11-05").find((row) => row.via === "portals")!.tokens[18], 55);
});

test("the hour chart adds every type once: the reasoning is already in the output", () => {
  const store = new UsageStore(folder(), { timeZone: "UTC" });
  store.apply(file("/a.jsonl", 1, [request("2026-11-05T10:00:00Z", 1, 100, { cacheRead: 1000, cacheWrite: 10, cacheWrite1h: 10, reasoning: 40 })]), () => "elsewhere");
  assert.equal(store.hourRowsBetween("2026-11-05", "2026-11-05")[0].tokens[10], 1111);
  assert.deepEqual(store.dayRows("2026-11-05", "2026-11-05").map((row) => [row.reasoning, row.cacheWrite1h]), [[40, 10]]);
});

test("a file read again replaces what it gave; a gone file's session taken up by another replaces it; a forgotten record keeps its counts", () => {
  const store = new UsageStore(folder(), { timeZone: "UTC" });
  const via = () => "elsewhere" as const;
  store.apply(file("/a.jsonl", 1, [request("2026-11-05T10:00:00Z", 10, 100)]), via);
  store.apply(file("/a.jsonl", 1, [request("2026-11-05T11:00:00Z", 20, 200)]), via);
  assert.deepEqual(store.dayRows("2026-11-05", "2026-11-05").map((row) => row.input), [30]);
  store.apply(file("/a.jsonl", 1, [request("2026-11-04T10:00:00Z", 7, 70)], true), via);
  assert.deepEqual(store.dayRows("2026-11-01", "2026-11-30").map((row) => [row.day, row.input]), [["2026-11-04", 7]]);
  assert.deepEqual(store.hourRowsBetween("2026-11-05", "2026-11-05"), []);
  store.apply({ type: "gone", path: "/a.jsonl", cursor: { ...cursor(1), gone: 5 } }, via);
  store.apply(file("/a.jsonl.zst", 2, [request("2026-11-04T10:00:00Z", 7, 70), request("2026-11-04T12:00:00Z", 1, 1)], false, ["/a.jsonl"]), via);
  assert.deepEqual(store.dayRows("2026-11-01", "2026-11-30").map((row) => [row.day, row.input, row.requests]), [["2026-11-04", 8, 2]]);
  assert.deepEqual(Object.keys(store.cursors()), ["/a.jsonl.zst"]);
  store.apply({ type: "forget", path: "/a.jsonl.zst" }, via);
  assert.deepEqual(store.cursors(), {});
  assert.deepEqual(store.dayRows("2026-11-01", "2026-11-30").map((row) => row.input), [8]);
});

test("everything is saved in one file and loaded again as it was; days counted keep their zone when the host's changes", () => {
  const where = folder();
  const store = new UsageStore(where, { timeZone: "Asia/Tokyo" });
  store.apply(file("/a.jsonl", 1, [request("2026-11-05T23:30:00Z", 10, 100)]), () => "portals");
  store.scannedAt = 1234;
  store.save();
  assert.equal(store.dirty, false);
  const text = readFileSync(join(where, "usage.json"), "utf8");
  assert.ok(!text.includes("\n "), "saved indented");
  const loaded = new UsageStore(where, { timeZone: "America/Vancouver" });
  loaded.load();
  assert.equal(loaded.scannedAt, 1234);
  assert.deepEqual(loaded.dayRows("2026-11-06", "2026-11-06"), store.dayRows("2026-11-06", "2026-11-06"));
  assert.deepEqual(loaded.hourRowsBetween("2026-11-06", "2026-11-06"), store.hourRowsBetween("2026-11-06", "2026-11-06"));
  assert.deepEqual(loaded.cursors(), store.cursors());
  // Read again on the new zone's days, the old file's counts are still replaced exactly.
  loaded.apply(file("/a.jsonl", 1, [request("2026-11-05T23:30:00Z", 10, 100)], true), () => "portals");
  assert.deepEqual(loaded.dayRows("2026-11-01", "2026-11-30").map((row) => [row.day, row.input]), [["2026-11-05", 10]]);
});

test("a saved file that cannot be used is read from its backup, and kept aside at the next save", () => {
  const where = folder();
  const store = new UsageStore(where, { timeZone: "UTC" });
  store.apply(file("/a.jsonl", 1, [request("2026-11-05T10:00:00Z", 10, 100)]), () => "elsewhere");
  store.save();
  store.apply(file("/a.jsonl", 1, [request("2026-11-05T11:00:00Z", 1, 1)]), () => "elsewhere");
  store.save();
  writeFileSync(join(where, "usage.json"), "{ half a file");
  const loaded = new UsageStore(where, { timeZone: "UTC" });
  loaded.load();
  assert.deepEqual(loaded.dayRows("2026-11-05", "2026-11-05").map((row) => row.input), [10]);
  loaded.save();
  assert.ok(JSON.parse(readFileSync(join(where, "usage.json"), "utf8")).v === 1);
  const fresh = new UsageStore(folder(), { timeZone: "UTC" });
  fresh.load();
  assert.equal(fresh.empty, true);
  assert.equal(existsSync(fresh.path), false);
});
