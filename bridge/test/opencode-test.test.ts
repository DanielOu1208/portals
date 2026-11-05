import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { stopFixture, stopFixtureChild } from "./opencode-process.ts";
import { test, onTestCleanup } from "./opencode-test.ts";

test("OpenCode test fixtures close after assertion failure and a never-settling body", () => {
  const script = `
    import assert from "node:assert/strict";
    import { after, before } from "node:test";
    import { test, onTestCleanup } from ${JSON.stringify(new URL("./opencode-test.ts", import.meta.url).href)};
    import { FakeOpenCode } from ${JSON.stringify(new URL("./opencode-serve.ts", import.meta.url).href)};
    let shared;
    before(async () => { shared = await FakeOpenCode.start(); }, { timeout: 1000 });
    after(async () => { await shared.close(); console.log("shared closed"); }, { timeout: 1000 });
    test("callback options", { timeout: 1000 }, (t, done) => {
      assert.equal(t.name, "callback options");
      setImmediate(done);
    });
    test("shared fixture survives another test", () => assert.equal(shared.server.listening, true));
    test("assertion failure", async () => {
      const fake = await FakeOpenCode.start();
      fake.server.once("close", () => console.log("assertion fixture closed"));
      assert.fail("deliberate assertion failure");
    });
    test("timeout", { timeout: 100 }, async () => {
      const fake = await FakeOpenCode.start();
      fake.server.once("close", () => console.log("timeout fixture closed"));
      await new Promise(() => {});
    });
    test({ timeout: 1000 }, () => {
      assert.equal(shared.server.listening, true);
      onTestCleanup(() => console.log("options-only cleanup"));
    });
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test-reporter=tap", "--input-type=module", "--eval", script], {
    env, encoding: "utf8", timeout: 10_000,
  });
  const output = result.stdout + result.stderr;
  assert.ifError(result.error);
  assert.equal(result.signal, null, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /deliberate assertion failure/);
  assert.match(output, /testTimeoutFailure/);
  for (const marker of ["assertion fixture closed", "timeout fixture closed", "options-only cleanup", "shared closed"]) {
    assert.ok(output.includes(marker), `missing ${marker}: ${output}`);
  }
  assert.doesNotMatch(output, /cancelledByParent|hookFailed|callbackAndPromisePresent/);
});

test("OpenCode cleanup stays bounded with mocked timers and a stuck cleanup callback", () => {
  const script = `
    import { test, onTestCleanup } from ${JSON.stringify(new URL("./opencode-test.ts", import.meta.url).href)};
    import { FakeOpenCode } from ${JSON.stringify(new URL("./opencode-serve.ts", import.meta.url).href)};
    test("stuck cleanup", async (t) => {
      const fake = await FakeOpenCode.start();
      fake.server.once("close", () => console.log("independent fixture closed"));
      t.mock.timers.enable({ apis: ["setTimeout"] });
      onTestCleanup(() => new Promise(() => {}));
    });
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test-reporter=tap", "--input-type=module", "--eval", script], {
    env, encoding: "utf8", timeout: 10_000,
  });
  const output = result.stdout + result.stderr;
  assert.ifError(result.error);
  assert.equal(result.signal, null, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /independent fixture closed/);
  assert.match(output, /OpenCode test cleanup timed out/);
});


test("emergency cleanup refuses a different orphan identity and stops a child only once", async () => {
  const child = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  onTestCleanup(() => stopFixtureChild(child));
  await once(child.stdout!, "data");
  const wrongIdentity = { pid: child.pid!, group: child.pid!, start: "another-process-start" };
  const refusal = stopFixture(wrongIdentity);
  await refusal;
  assert.equal(stopFixture(wrongIdentity), refusal);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  process.kill(child.pid!, 0);
  const stopped = stopFixtureChild(child);
  assert.equal(stopFixtureChild(child), stopped);
  await stopped;
  assert.equal(child.signalCode, "SIGKILL");
});
