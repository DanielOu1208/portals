import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests run inside agent sessions too. HOME alone does not isolate them: an inherited
// provider home, XDG folder or bridge override can still select the person's real files.
// Clear these before a suite creates its fixtures; explicit settings within a test stay.
export const testHome = realpathSync(mkdtempSync(join(tmpdir(), "portals-test-home-")));
for (const key of Object.keys(process.env)) {
  if (/^(?:FACTORY_|DROID_|CLAUDE_|CODEX_|PI_|CURSOR_|HERMES_|XDG_|PORTALS_|AERIPORTAL_)/.test(key)) delete process.env[key];
}
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

// Not an after hook: subprocesses can import this too without starting a test harness.
process.once("exit", () => rmSync(testHome, { recursive: true, force: true }));
