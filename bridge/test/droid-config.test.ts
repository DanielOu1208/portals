import "./environment.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, defaults, parseConfig, pathsFor } from "../src/config.ts";
import { appManifest } from "../src/setup/install.ts";
import { reportVersion } from "../src/providers/program.ts";
import { log } from "../src/log.ts";

test("Droid and gateway modules load from TypeScript under the runtime", async () => {
  await import("../src/providers/droid/provider.ts");
  await import("../src/gateway/methods.ts");
});

test("Droid is autodetected unless disabled, its pool settings are validated, and its state has a separate folder", (t) => {
  const home = mkdtempSync(join(tmpdir(), "portals-droid-config-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(defaults.providers.droid, true);
  assert.deepEqual(defaults.droid, { path: "~/.local/bin/droid", idleMinutes: 15, maxWarm: 6 });
  assert.equal(parseConfig({ providers: { claude: true } }).providers.droid, true);
  assert.equal(parseConfig({ providers: { droid: false } }).providers.droid, false);
  assert.deepEqual(parseConfig({}).droid, defaults.droid);
  const config = parseConfig({ providers: { droid: true }, droid: { path: "~/tools/droid", idleMinutes: 0.5, maxWarm: 2 } });
  assert.equal(config.providers.droid, true);
  assert.deepEqual(config.droid, { path: "~/tools/droid", idleMinutes: 0.5, maxWarm: 2 });
  assert.equal(pathsFor(home).droid, join(home, "state", "droid"));
  // Names: the thread's own model unless one is named; null leaves them to Droid.
  assert.equal(parseConfig({ droid: { titleModel: "glm-5.3-flash" } }).droid.titleModel, "glm-5.3-flash");
  assert.equal(parseConfig({ droid: { titleModel: null } }).droid.titleModel, null);
  assert.equal(parseConfig({}).droid.titleModel, undefined);
  for (const [bad, sentence] of [
    [{ providers: { droid: "yes" } }, "providers.droid must be true or false."],
    [{ droid: [] }, "droid must be an object."],
    [{ droid: "droid" }, "droid must be an object."],
    ...["", " ", 3].map((path) => [{ droid: { path } }, "droid.path must be the path of the installed droid."]),
    ...[0, -1, "15", Infinity, NaN].map((idleMinutes) => [{ droid: { idleMinutes } }, "droid.idleMinutes must be a number above 0."]),
    ...[0, 1.5, "6", Infinity].map((maxWarm) => [{ droid: { maxWarm } }, "droid.maxWarm must be a whole number, 1 or more."]),
    ...["", "glm 5", 3].map((titleModel) => [{ droid: { titleModel } }, 'droid.titleModel must name a model as Droid lists it ("glm-5.3-flash"), or be null to leave the names to Droid.']),
  ] as [Record<string, unknown>, string][]) {
    assert.throws(() => parseConfig(bad), (error: Error) => error instanceof ConfigError && error.message === sentence);
  }
});

test("the installed bridge keeps the SDK's security override", () => {
  const overrides = { "@factory/droid-sdk": { uuid: "11.1.1" } };
  assert.deepEqual(appManifest({ name: "portals-bridge", version: "0.1.0",
    dependencies: { "@factory/droid-sdk": "0.10.0" }, overrides }).overrides, overrides);
});

test("every recorded Droid CLI release is accepted without a version warning", (t) => {
  const warnings: string[] = [];
  t.mock.method(log, "warn", (message: string) => { warnings.push(message); });
  t.mock.method(log, "info", () => {});
  const report = { name: "Droid", tested: ["0.236.0", "0.245.0", "0.247.0"], path: "/test/droid", setting: "droid.path" };
  for (const version of report.tested) reportVersion({ ...report, version });
  assert.deepEqual(warnings, []);
  reportVersion({ ...report, version: "0.999.0" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /0\.236\.0, 0\.245\.0, 0\.247\.0/);
});
