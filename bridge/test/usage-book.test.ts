import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { setLogLevel } from "../src/log.ts";
import { startUsageBook, type ViaResolver } from "../src/usage/book.ts";
import type { Source } from "../src/usage/readers/common.ts";
import type { UsageAgent, UsageVia } from "../src/usage/types.ts";
import { historyHome } from "./usage-fixtures.ts";

// The book (src/usage/book.ts): history read in its own process and added to the days,
// through Portals or elsewhere as the host's resolver says, read again after a poke,
// saved and loaded again without counting twice, and a reader that fails never taking
// the host with it.

setLogLevel("silent");

const s1 = "11111111-1111-4111-8111-111111111111";
const taken = Date.parse("2026-11-05T09:00:06Z");

function totals(rows: { agent: UsageAgent; via: UsageVia; input: number; output: number; requests: number }[], agent: UsageAgent, via?: UsageVia) {
  const mine = rows.filter((row) => row.agent === agent && (via === undefined || row.via === via));
  return { input: mine.reduce((sum, row) => sum + row.input, 0), output: mine.reduce((sum, row) => sum + row.output, 0), requests: mine.reduce((sum, row) => sum + row.requests, 0) };
}

test("the reader reads every agent's history; the resolver says what went through Portals, and Codex's Portals originator always does", async () => {
  const home = historyHome();
  const stateDir = mkdtempSync(join(tmpdir(), "portals-usage-book-"));
  const asked: [UsageAgent, string, number, string | undefined][] = [];
  const via: ViaResolver = (agent, session, at, originator) => {
    asked.push([agent, session, at, originator]);
    return agent === "claude" && session === s1 && at >= taken ? "portals" : "elsewhere";
  };
  const book = startUsageBook({ stateDir, home, env: {}, via, timeZone: "UTC", pokeMs: 10 });
  try {
    await book.scanned();
    assert.deepEqual(book.agents, ["claude", "codex", "pi", "droid"]);
    assert.equal(book.timeZone, "UTC");
    const state = book.scan();
    assert.equal(state.scanning, false);
    assert.equal(typeof state.scannedAt, "number");
    const rows = book.days("2026-11-01", "2026-11-30");
    // The first request was before the session was taken up; the rest of its session and
    // its subagent's after.
    assert.deepEqual(totals(rows, "claude", "elsewhere"), { input: 11, output: 125, requests: 2 });
    assert.deepEqual(totals(rows, "claude", "portals"), { input: 338, output: 140, requests: 3 });
    assert.deepEqual(totals(rows, "codex", "portals"), { input: 1750, output: 190, requests: 5 });
    assert.deepEqual(totals(rows, "codex", "elsewhere"), { input: 1000, output: 100, requests: 1 });
    assert.deepEqual(totals(rows, "pi"), { input: 915, output: 200, requests: 3 });
    assert.deepEqual(totals(rows, "droid"), { input: 40, output: 900, requests: 0 });
    assert.ok(!asked.some(([, , , originator]) => originator === "portals-bridge"), "the resolver was asked about a session Codex says Portals started");
    assert.ok(asked.some(([agent, , , originator]) => agent === "codex" && originator === "codex-tui"));
    assert.ok(book.hours("2026-11-05", "2026-11-05").every((row) => row.tokens.length === 24));

    // A turn ended: what it wrote is read a moment after the poke.
    const file = join(home, ".claude", "projects", "-Users-dana-code-app", `${s1}.jsonl`);
    appendFileSync(file, `${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", id: "msg_dana_e", role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, requestId: "req_dana_e", timestamp: "2026-11-06T08:00:00.000Z", cwd: "/Users/dana/code/app", sessionId: s1 })}\n`);
    const next = book.scanned();
    book.poke();
    await next;
    assert.deepEqual(totals(book.days("2026-11-06", "2026-11-06"), "claude", "portals"), { input: 32, output: 13, requests: 2 });
  } finally {
    await book.stop();
  }
  assert.ok(existsSync(join(stateDir, "usage", "usage.json")));

  // Started again on what it saved: the same totals, nothing read twice.
  const again = startUsageBook({ stateDir, home, env: {}, via, timeZone: "UTC", inProcess: true });
  try {
    const loaded = again.days("2026-11-01", "2026-11-30");
    await again.scanned();
    assert.deepEqual(again.days("2026-11-01", "2026-11-30"), loaded);
  } finally {
    await again.stop();
  }
});

test("a resolver that throws counts as elsewhere", async () => {
  const home = historyHome(["claude"]);
  const book = startUsageBook({ stateDir: mkdtempSync(join(tmpdir(), "portals-usage-book-")), home, env: {}, timeZone: "UTC", inProcess: true, via: () => { throw new Error("no record"); } });
  try {
    await book.scanned();
    const rows = book.days("2026-11-01", "2026-11-30");
    assert.ok(rows.length > 0 && rows.every((row) => row.via === "elsewhere"));
  } finally {
    await book.stop();
  }
});

test("a reader that fails as it starts, or ends while reading, leaves the host going and the book answering", async () => {
  for (const name of ["fails.ts", "ends.ts"]) {
    const book = startUsageBook({ stateDir: mkdtempSync(join(tmpdir(), "portals-usage-book-")), home: historyHome(["claude"]), env: {}, via: () => "elsewhere", worker: new URL(`./fixtures/usage-workers/${name}`, import.meta.url), restartMs: 20, everyMs: 40 });
    try {
      await book.scanned();
      await book.scanned();
      assert.deepEqual(book.days("2026-11-01", "2026-11-30"), [], name);
      assert.equal(book.scan().scannedAt, undefined, name);
    } finally {
      await book.stop();
    }
  }
});

test("scans never run two at once: a burst of pokes while one runs is one more scan", async () => {
  const home = mkdtempSync(join(tmpdir(), "portals-usage-book-"));
  const root = join(home, "history");
  mkdirSync(root);
  const line = `${JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })}\n`;
  writeFileSync(join(root, "one.jsonl.zst"), zstdCompressSync(Buffer.from(line.repeat(300_000))));
  let active = 0;
  let most = 0;
  let scans = 0;
  const source: Source = {
    agent: "codex",
    root,
    kind: () => "snapshot",
    accepts: () => {
      scans++;
      return true;
    },
    needles: ['"token_count"'],
    parser: () => {
      active++;
      most = Math.max(most, active);
      return { line: () => undefined, save: () => (active--, undefined) };
    },
  };
  // Every scan reads the file again: its time is moved on before each.
  const book = startUsageBook({ stateDir: join(home, "state"), home, env: {}, via: () => "elsewhere", inProcess: true, sources: [source], pokeMs: 1 });
  try {
    await book.scanned();
    const { utimesSync } = await import("node:fs");
    utimesSync(join(root, "one.jsonl.zst"), new Date(), new Date(Date.now() + 5_000));
    const before = scans;
    const next = book.scanned();
    // The first poke starts a scan that takes a while; the others come while it runs.
    book.poke();
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let index = 0; index < 4; index++) {
      book.poke();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await next;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(scans - before >= 1 && scans - before <= 2, `scans: ${scans - before}`);
    assert.equal(most, 1);
  } finally {
    await book.stop();
  }
});

test("a scan that finds nothing new writes nothing; its time is written on stop", async () => {
  const home = historyHome(["claude"]);
  const stateDir = mkdtempSync(join(tmpdir(), "portals-usage-book-"));
  const saved = join(stateDir, "usage", "usage.json");
  const book = startUsageBook({ stateDir, home, env: {}, via: () => "elsewhere", timeZone: "UTC", inProcess: true, pokeMs: 1, saveEveryMs: 0 });
  let last = 0;
  try {
    await book.scanned();
    // The first scan ever is written, its time with it.
    const first = statSync(saved, { bigint: true });
    assert.equal(typeof JSON.parse(readFileSync(saved, "utf8")).scannedAt, "number");
    for (let index = 0; index < 4; index++) {
      const next = book.scanned();
      book.poke();
      await next;
    }
    const after = statSync(saved, { bigint: true });
    assert.equal(after.ino, first.ino, "an idle scan wrote the totals again");
    assert.equal(after.mtimeNs, first.mtimeNs);
    last = book.scan().scannedAt ?? 0;
    assert.ok(last > 0);
  } finally {
    await book.stop();
  }
  assert.equal(JSON.parse(readFileSync(saved, "utf8")).scannedAt, last);
});
