import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Tests run inside agent sessions too. HOME alone does not isolate them: an inherited
// provider home, XDG folder or bridge override can still select the person's real files.
// Clear these before a suite creates its fixtures; explicit settings within a test stay.
export const testHome = realpathSync(mkdtempSync(join(tmpdir(), "portals-test-home-")));
// The home this process came with, for a live script: a real agent's program and sign-in are
// there, and homedir() answers with the scratch home from here on.
export const realHome = homedir();
for (const key of Object.keys(process.env)) {
  if (/^(?:FACTORY_|DROID_|CLAUDE_|CODEX_|PI_|CURSOR_|HERMES_|XDG_|PORTALS_|AERIPORTAL_)/.test(key)) delete process.env[key];
}
// A bridge a test starts never sends the anonymous totals to the real server (usage/telemetry.ts);
// a test of them gives its own environment.
process.env.PORTALS_TELEMETRY = "0";
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

// Not an after hook: subprocesses can import this too without starting a test harness.
process.once("exit", () => rmSync(testHome, { recursive: true, force: true }));
