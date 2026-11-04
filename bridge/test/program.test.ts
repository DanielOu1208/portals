import "./environment.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setLogLevel } from "../src/log.ts";
import { machineWord } from "../src/platform.ts";
import { claudeAgents } from "../src/providers/claude/options.ts";
import { compareVersions, programVersion, userAgentVersion, versionStanding, VersionCheck } from "../src/providers/program.ts";
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

/** What `run` logs, without the time each line starts with. */
function logged(t: TestContext, run: () => void): string[] {
  const written = t.mock.method(process.stderr, "write", () => true);
  setLogLevel("info");
  try {
    run();
  } finally {
    setLogLevel("silent");
    written.mock.restore();
  }
  return written.mock.calls.map((call) => String(call.arguments[0]).trimEnd().split(" ").slice(1).join(" "));
}

const pi = { name: "Pi", tested: ["1.1.0", "1.5.0"], minimum: "1.1.0", update: "pi update", path: "/opt/bin/pi", setting: "pi.path" };

test("releases are ordered by their three numbers; a build past a release comes after it, a pre-release before", () => {
  assert.ok(compareVersions("1.5.0", "1.10.0") < 0);
  assert.ok(compareVersions("2.1.320", "2.1.318") > 0);
  assert.equal(compareVersions("2026.10.22", "2026.10.22"), 0);
  // Hermes's own builds say how far past a release they are.
  assert.ok(compareVersions("0.22.5+12.g1a2b3c4", "0.22.5") > 0);
  assert.ok(compareVersions("0.22.5+12.g1a2b3c4", "0.22.6") < 0);
  assert.ok(compareVersions("0.22.5-rc.1", "0.22.5") < 0);
});

test("a release is tested, newer than all tested, another, too old, or missing", () => {
  assert.equal(versionStanding(pi, "1.1.0"), "tested");
  assert.equal(versionStanding(pi, "1.5.0"), "tested");
  assert.equal(versionStanding(pi, "1.6.0"), "newer");
  // Between two tested releases, and so not one of them.
  assert.equal(versionStanding(pi, "1.3.2"), "untested");
  assert.equal(versionStanding(pi, "0.99.2"), "too old");
  assert.equal(versionStanding(pi, null), "missing");
  // Without a minimum nothing is too old: an older release is only another one.
  assert.equal(versionStanding({ tested: "2.1.318" }, "2.0.0"), "untested");
  assert.equal(versionStanding({ tested: "2.1.318" }, "2.1.320"), "newer");
});

test("each release is logged once: an error when none runs or one is too old, a warning for one newer or another, a line for a tested one", (t) => {
  const check = new VersionCheck(pi);
  const lines = logged(t, () => {
    check.installedIs(null);
    check.installedIs("1.6.0");
    check.installedIs("1.3.2");
    check.installedIs("0.99.2");
    check.installedIs("1.5.0");
    // Said again: nothing more.
    check.installedIs(null);
    check.installedIs("1.6.0");
    check.runningIs("1.5.0");
  });
  assert.deepEqual(lines, [
    "error Pi was not found or did not run at /opt/bin/pi. Set pi.path in config.json.",
    "warn  Pi is 1.6.0, newer than this bridge was tested with (1.1.0, 1.5.0). Check a thread before relying on it.",
    "warn  Pi is 1.3.2; this bridge was tested with 1.1.0, 1.5.0. Check a thread before relying on it.",
    "error Pi is 0.99.2, which is too old for this bridge: it needs 1.1.0 or newer. No Pi thread runs until it is updated (pi update).",
    "info  Pi 1.5.0",
  ]);
});

test("what a running process says of itself is the release known, over --version, and is logged as its", (t) => {
  const check = new VersionCheck({ name: "Codex", tested: "0.166.0", path: "/opt/bin/codex", setting: "codex.path" });
  assert.equal(check.current(), null);
  assert.equal(check.statusLine(), null);
  const lines = logged(t, () => {
    check.installedIs("0.167.0");
    // Not a release: left out.
    check.runningIs(undefined);
    check.runningIs("dev build");
    assert.deepEqual(check.current(), { name: "Codex", version: "0.167.0", standing: "newer", running: false });
    // The daemon joined still runs the release before.
    check.runningIs("0.166.0");
  });
  assert.deepEqual(check.current(), { name: "Codex", version: "0.166.0", standing: "tested", running: true });
  assert.deepEqual(lines, [
    "warn  Codex is 0.167.0, newer than this bridge was tested with (0.166.0). Check a thread before relying on it.",
    'info  Codex 0.166.0 {"from":"its running process"}',
  ]);
  // A later `--version` does not move what the running process said.
  check.installedIs("0.168.0");
  assert.equal(check.current()?.version, "0.166.0");
});

test("only a release older than the minimum refuses a turn, with what to run", () => {
  const check = new VersionCheck(pi);
  for (const version of [null, "1.1.0", "1.3.2", "1.6.0"]) {
    check.installedIs(version);
    assert.equal(check.refusal(), null, String(version));
  }
  check.installedIs("0.99.2");
  assert.equal(check.refusal(), `Pi 0.99.2 is too old for the bridge, which needs 1.1.0 or newer. Update it on the ${machineWord()} (pi update), then send the message again.`);
  // An agent with no minimum refuses none.
  const claude = new VersionCheck({ name: "Claude Code", tested: "2.1.318", path: "claude", setting: "claude.path" });
  claude.installedIs("0.1.0");
  assert.equal(claude.refusal(), null);
});

test("/status says the release and what is off about it", () => {
  const line = (version: string | null) => {
    const check = new VersionCheck(pi);
    check.installedIs(version);
    return check.statusLine();
  };
  assert.equal(line("1.5.0"), "Version: Pi 1.5.0");
  assert.equal(line("1.6.0"), "Version: Pi 1.6.0, newer than the 1.5.0 Portals was tested with");
  assert.equal(line("1.3.2"), "Version: Pi 1.3.2, not one Portals was tested with (the newest it was is 1.5.0)");
  assert.equal(line("0.99.2"), "Version: Pi 0.99.2, older than 1.1.0, the oldest Portals runs. Update it (pi update).");
  assert.equal(line(null), "Version: Pi was not found or did not run at /opt/bin/pi. Set pi.path in config.json.");
});

test("Codex's release is the one its user agent names, whoever the client is", () => {
  assert.equal(userAgentVersion("portals-bridge/0.166.0 (Mac OS 27.0.0; arm64) xterm-256color (portals-bridge; 0.3.2)"), "0.166.0");
  assert.equal(userAgentVersion("codex_cli_rs/0.162.1"), "0.162.1");
  assert.equal(userAgentVersion("portals-bridge"), null);
  assert.equal(userAgentVersion(undefined), null);
});
