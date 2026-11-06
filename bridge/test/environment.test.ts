import "./environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("inherited provider homes cannot escape the test's scratch home", (t) => {
  const outside = mkdtempSync(join(tmpdir(), "portals-test-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const environment = new URL("./environment.ts", import.meta.url).href;
  const config = new URL("../src/config.ts", import.meta.url).href;
  const droid = new URL("../src/providers/droid/provider.ts", import.meta.url).href;
  const pi = new URL("../src/providers/pi/history.ts", import.meta.url).href;
  const hermes = new URL("../src/providers/hermes/serve.ts", import.meta.url).href;
  const locate = new URL("../src/search/locate.ts", import.meta.url).href;
  const keys = ["FACTORY_HOME_OVERRIDE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR",
    "CURSOR_CONFIG_DIR", "HERMES_HOME", "HERMES_GATEWAY_LOCK_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR", "PORTALS_BRIDGE_HOME", "AERIPORTAL_BRIDGE_HOME", "PORTALS_THREAD"];
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { homedir } from "node:os";
    import { isAbsolute, relative } from "node:path";
    const { testHome } = await import(${JSON.stringify(environment)});
    for (const key of ${JSON.stringify(keys)}) assert.equal(process.env[key], undefined, key);
    assert.equal(process.env.PORTALS_TELEMETRY, "0");
    const { bridgeHome } = await import(${JSON.stringify(config)});
    const { DroidProvider } = await import(${JSON.stringify(droid)});
    const { agentFolder, movedSessions } = await import(${JSON.stringify(pi)});
    const { lockDirectory } = await import(${JSON.stringify(hermes)});
    const { CodexRollouts } = await import(${JSON.stringify(locate)});
    const provider = new DroidProvider({ command: "/not-a-real-droid", directory: testHome, idleMs: 1, maxWarm: 1, sdk: {}, checkVersion: false });
    const homes = [homedir(), bridgeHome(), provider.files.root, agentFolder(), lockDirectory(), new CodexRollouts().home];
    for (const home of homes) {
      const path = relative(testHome, home);
      assert.ok(!isAbsolute(path) && path !== ".." && !path.startsWith("../"), home);
    }
    assert.equal(movedSessions(process.env, testHome), null);
    console.log(testHome);
  `], {
    env: { ...process.env, HOME: outside, ...Object.fromEntries(keys.map((key) => [key, outside])) },
    encoding: "utf8",
    timeout: 10_000,
    cwd: fileURLToPath(new URL("../", import.meta.url)),
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(result.stdout.trim()), false, "the subprocess removes its scratch home on exit");
  assert.deepEqual(readdirSync(outside), [], "even the poisoned provider roots are untouched");
});

test("the home a process came with stays known after HOME moves", (t) => {
  const outside = mkdtempSync(join(tmpdir(), "portals-test-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const environment = new URL("./environment.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { homedir } from "node:os";
    const { realHome, testHome } = await import(${JSON.stringify(environment)});
    console.log(JSON.stringify([realHome, testHome, homedir(), process.env.HOME]));
  `], {
    env: { ...process.env, HOME: outside, USERPROFILE: outside },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [realHome, testHome, home, variable] = JSON.parse(result.stdout);
  assert.equal(realHome, outside);
  assert.notEqual(testHome, outside);
  assert.equal(home, testHome);
  assert.equal(variable, testHome);
});

test("a script on the test helpers takes the real home from the environment, not from homedir()", () => {
  const scripts = new URL("../scripts/", import.meta.url);
  const onHelpers = readdirSync(scripts).filter((name) => name.endsWith(".ts") && readFileSync(new URL(name, scripts), "utf8").includes('"../test/helpers.ts"'));
  assert.ok(onHelpers.includes("live-cursor.ts"), onHelpers.join());
  for (const name of onHelpers) assert.doesNotMatch(readFileSync(new URL(name, scripts), "utf8"), /\bhomedir\(/, name);
});

test("the test-process preload does not replace a spawned child's explicit home", (t) => {
  const home = mkdtempSync(join(tmpdir(), "portals-test-child-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { homedir } from "node:os";
    console.log(JSON.stringify([homedir(), process.env.HOME, process.env.USERPROFILE,
      process.env.FACTORY_HOME_OVERRIDE, process.env.PI_CODING_AGENT_SESSION_DIR]));
  `], {
    env: { ...process.env, HOME: home, USERPROFILE: home, FACTORY_HOME_OVERRIDE: home, PI_CODING_AGENT_SESSION_DIR: home },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [home, home, home, home, home]);
  assert.ok(existsSync(home), "the child neither replaces nor removes its explicitly configured home");
});
