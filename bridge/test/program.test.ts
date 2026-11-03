import "./environment.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import { claudeAgents } from "../src/providers/claude/options.ts";
import { programVersion, reportVersion } from "../src/providers/program.ts";
import { deafPid, deafRuns, type DeafProgram } from "./deaf-program.ts";

// What an agent's program says its version is, and what the bridge logs about it at
// start. A small script stands in for the program: `--version` prints what $SAYS holds
// and ends with the code in $CODE.

let folder: string;
let program: string;

before(() => {
  folder = mkdtempSync(join(tmpdir(), "portals-program-"));
  program = join(folder, "agent");
  writeFileSync(program, '#!/bin/sh\n[ "$1" = "--version" ] || exit 9\necho "$SAYS"\nexit "${CODE:-0}"\n');
  chmodSync(program, 0o755);
});

/** The programs the tests of programs that ignore SIGTERM started (test/deaf-program.ts). */
const deafPrograms: DeafProgram[] = [];

after(() => {
  setLogLevel("silent");
  // Any left running ended first, while their pid files are still there to say which.
  for (const program of deafPrograms) {
    const pid = deafPid(program);
    if (pid === null) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already, as it should be.
    }
  }
  rmSync(folder, { recursive: true, force: true });
});

test("a program's version is the part of what --version prints that the pattern captures", async () => {
  assert.equal(await programVersion(program, { SAYS: "codex-cli 0.160.1" }), "0.160.1");
  assert.equal(await programVersion(program, { SAYS: "2.1.292 (Claude Code)" }), "2.1.292");
  assert.equal(await programVersion(program, { SAYS: "Hermes Agent v0.21.5+5295.g234badf (2026.9.24)" }, /v(\d+\.\d+\.\d+\S*)/), "0.21.5+5295.g234badf");
  // Nothing like a version, a program that fails, and one that is not there.
  assert.equal(await programVersion(program, { SAYS: "agent, nightly build" }), null);
  assert.equal(await programVersion(program, { SAYS: "1.2.3", CODE: "1" }), null);
  assert.equal(await programVersion(join(folder, "missing"), {}), null);
});

/**
 * The first timeout the tests of programs that ignore SIGTERM give them, doubled while a
 * busy Mac killed the program before it set its trap (test/deaf-program.ts).
 */
const deafTimeoutMs = 1000;

/** `run` raced against three times its timeout: "still running" when it was not over by then. */
async function within<T>(timeoutMs: number, run: Promise<T>): Promise<T | "still running"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([run, new Promise<"still running">((resolve) => (timer = setTimeout(() => resolve("still running"), 3 * timeoutMs)))]);
  } finally {
    clearTimeout(timer);
  }
}

test("`claude agents` that ignores SIGTERM still ends at its timeout, failing, so a desk thread's start is not held up for good", async () => {
  const runs: Promise<unknown>[] = [];
  const { result, pid } = await deafRuns(folder, "deaf-claude", deafTimeoutMs, (program, timeoutMs) => {
    const listing = claudeAgents(program.path, {}, timeoutMs).then(() => "listed", (error: Error) => error.message);
    runs.push(listing);
    return within(timeoutMs, listing);
  }, (program) => deafPrograms.push(program));
  assert.ok(pid !== null, "the program never got as far as ignoring SIGTERM");
  assert.match(String(result), /^claude agents failed/);
  assert.throws(() => process.kill(pid, 0));
  await Promise.all(runs);
});

test("a version check that ignores SIGTERM still ends at its timeout", async () => {
  const runs: Promise<unknown>[] = [];
  const { result, pid } = await deafRuns(folder, "deaf-agent", deafTimeoutMs, (program, timeoutMs) => {
    const version = programVersion(program.path, {}, undefined, timeoutMs);
    runs.push(version);
    return within(timeoutMs, version);
  }, (program) => deafPrograms.push(program));
  assert.ok(pid !== null, "the program never got as far as ignoring SIGTERM");
  assert.equal(result, null);
  assert.throws(() => process.kill(pid, 0));
  await Promise.all(runs);
});

test("at start the bridge logs the version: an error when none runs, a warning when it is not the tested one", (t) => {
  const written = t.mock.method(process.stderr, "write", () => true);
  setLogLevel("info");
  const agent = { name: "Pi", tested: "1.1.0", path: "/opt/bin/pi", setting: "pi.path" };
  reportVersion({ ...agent, version: null });
  reportVersion({ ...agent, version: "1.2.0" });
  reportVersion({ ...agent, version: "1.1.0" });
  setLogLevel("silent");
  // Without the time each line starts with.
  const lines = written.mock.calls.map((call) => String(call.arguments[0]).trimEnd().split(" ").slice(1).join(" "));
  assert.deepEqual(lines, [
    "error Pi was not found or did not run at /opt/bin/pi. Set pi.path in config.json.",
    "warn  Pi is 1.2.0; this bridge was tested with 1.1.0. Check a thread before relying on it.",
    "info  Pi 1.1.0",
  ]);
});
