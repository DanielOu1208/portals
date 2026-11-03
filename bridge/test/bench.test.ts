import "./environment.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Scratch } from "../scripts/bench/scratch.ts";

// The harness (scripts/bench.ts): its short run end to end, as a
// process, and the rule that keeps it away from every folder but its own.

const bench = fileURLToPath(new URL("../scripts/bench.ts", import.meta.url));
const scenarios = ["idle", "turns", "marks", "fleet", "stream", "loads", "connect", "network", "pushes", "resume", "tokens", "cost"];

interface Report {
  failed?: string;
  bridges_started: number[];
  tables: { scenario: string; columns: string[]; rows: unknown[][] }[];
}

function temporaryFolder(t: { after(cleanup: () => void): void }): string {
  const folder = mkdtempSync(join(tmpdir(), "portals-bench-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

test("the harness's short run prints a table for each scenario, writes their rows as JSON, and leaves no bridge and nothing in its scratch folder", { skip: process.env.BENCH_TESTS !== "1" && "run npm run test:bench" }, async (t) => {
  const folder = temporaryFolder(t);
  const scratch = join(folder, "scratch");
  const json = join(folder, "report.json");
  const ran = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [bench, "--quick", "--only", "all", "--scratch", scratch, "--json", json], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
  assert.equal(ran.code, 0, ran.stderr);
  for (const name of scenarios) assert.match(ran.stdout, new RegExp(`^### ${name}: .+\\n\\nTaken .+\\n\\n\\| .+ \\|\\n\\|[-|]+\\|\\n\\| .+ \\|$`, "m"), `a table for ${name}`);

  const report = JSON.parse(readFileSync(json, "utf8")) as Report;
  assert.equal(report.failed, undefined);
  for (const name of scenarios) {
    const tables = report.tables.filter((table) => table.scenario === name);
    assert.ok(tables.length > 0, `rows for ${name}`);
    for (const table of tables) {
      assert.ok(table.rows.length > 0, `${name} has rows`);
      for (const row of table.rows) assert.equal(row.length, table.columns.length, `${name}: a cell for every column`);
    }
  }
  // With the counters on, the bridges' own lines were read: a turn wrote threads.json.
  const turns = report.tables.find((table) => table.scenario === "turns")!;
  const writes = turns.rows[0][turns.columns.indexOf("threads.json writes a turn")];
  assert.ok(typeof writes === "number" && writes > 0, `threads.json writes a turn: ${String(writes)}`);

  // A device told to poll heard poll.now and polled; one that is not told heard none; at rest none is told.
  const pushes = report.tables.filter((table) => table.scenario === "pushes");
  const costs = pushes.find((table) => table.columns.includes("Device"))!;
  const told = (row: unknown[]) => row[costs.columns.indexOf("poll.now a turn")] as number;
  assert.equal(told(costs.rows[0]), 0);
  for (const row of costs.rows.slice(1)) assert.ok(told(row) > 0 && (row[costs.columns.indexOf("sessions.activity a turn")] as number) > 0, `${String(row[0])} was told to poll`);
  const idle = report.tables.find((table) => table.scenario === "idle")!;
  assert.equal(idle.rows[0][idle.columns.indexOf("poll.now events")], 0);

  // What the portals command prints is measured, and one read crosses the link.
  const tokens = report.tables.find((table) => table.scenario === "tokens")!;
  for (const command of ["threads", "read", "wait"]) {
    const row = tokens.rows.find((cells) => String(cells[0]).startsWith(`\`portals ${command}\``));
    assert.ok(row && typeof row[1] === "number" && row[1] > 0, `portals ${command} printed`);
  }
  const fleet = report.tables.find((table) => table.scenario === "fleet")!;
  const read = fleet.rows.find((cells) => cells[1] === "thread.read");
  assert.ok(read && (read[fleet.columns.indexOf("Bytes back a call")] as number) > 30_000, "a read of the long thread through the link");

  // Over the bad link: what crossed it was counted, and the device that stopped reading caught up.
  const network = report.tables.filter((table) => table.scenario === "network");
  const connects = network.find((table) => table.columns.includes("Bytes over the link down"))!;
  const cell = (row: unknown[], column: string) => row[connects.columns.indexOf(column)] as number;
  for (const row of connects.rows) {
    // Every byte the device sent, with HTTP's headers and WebSocket's framing on top: its calls are too small to be compressed.
    assert.ok(cell(row, "Bytes over the link up") > cell(row, "Bytes up"), `bytes over the link up: ${cell(row, "Bytes over the link up")} for ${cell(row, "Bytes up")} sent`);
    assert.ok(cell(row, "Bytes over the link down") > 0, "bytes over the link down");
  }
  // The first connect's list crossed compressed, as the app takes it: fewer bytes than it holds, but not next to none.
  const first = connects.rows.find((row) => row[1] === "first")!;
  const down = cell(first, "Bytes over the link down");
  assert.ok(down < cell(first, "Bytes down") && down > cell(first, "Bytes down") / 20, `bytes over the link down: ${down} for ${cell(first, "Bytes down")} received`);
  const stalls = network.find((table) => table.columns.includes("Closed by the bridge"))!;
  const flood = stalls.rows.find((cells) => cells[0] === "a flood");
  assert.ok(flood && (flood[stalls.columns.indexOf("KB sent it meanwhile")] as number) > 100, "the flood was sent while the device did not read");

  assert.ok(report.bridges_started.length > 0);
  for (const pid of report.bridges_started) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `bridge ${pid} is gone`);
  assert.deepEqual(readdirSync(scratch), []);
});

test("the harness starts no bridge and runs no portals command in a folder outside its scratch folder", async (t) => {
  const folder = temporaryFolder(t);
  const outside = join(folder, "outside");
  const scratch = new Scratch({ parent: join(folder, "scratch") });
  t.after(() => scratch.dispose());
  symlinkSync(folder, join(scratch.root, "link"));

  // Elsewhere, the scratch folder itself, a path that climbs out of it, and a link in it that leads out.
  for (const home of [outside, scratch.root, join(scratch.root, "..", "..", "outside"), join(scratch.root, "link", "outside")]) {
    await assert.rejects(scratch.startBridge({ home, counters: false }), /refused/, home);
    await assert.rejects(scratch.portals(home, ["threads"]), /refused/, home);
  }
  assert.deepEqual(scratch.started, []);
  assert.equal(existsSync(outside), false);
});

test("a harness bridge runs on a port of the system's choice with the scripted agent only, no relay and no check for a later version, whatever a scenario asks for", async (t) => {
  const folder = temporaryFolder(t);
  const scratch = new Scratch({ parent: folder });
  t.after(() => scratch.dispose());
  const home = scratch.folder("asked");
  const asked = { port: 9120, generalFolder: "~/Portals", providers: { claude: true, codex: true, hermes: true, fake: false }, push: { relay: "https://relay.example" }, fake: { delayMs: 3 } };
  const bridge = await scratch.startBridge({ home, counters: false, config: asked });

  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(config.port, 0);
  assert.notEqual(new URL(bridge.url).port, "9120");
  assert.deepEqual(config.providers, { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: true });
  assert.equal(config.push.relay, null);
  assert.equal(config.relay.enabled, false);
  assert.equal(config.updates.check, false);
  assert.ok(scratch.owns(config.generalFolder) && scratch.owns(config.push.dryRun));
  assert.deepEqual(config.fake, { delayMs: 3 });

  // Its own numbers, asked for over the process's channel; then stopped and gone.
  const sample = await bridge.sample();
  assert.ok(sample.cpuMs > 0 && sample.rss > 0 && sample.heap > 0);
  await bridge.stop();
  assert.throws(() => process.kill(bridge.pid, 0), { code: "ESRCH" });
});
