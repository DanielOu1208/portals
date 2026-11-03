import "./environment.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildContract, contractPath, contractText } from "../src/gateway/contract.ts";
import { bridgeFeatures } from "../src/gateway/features.ts";
import { checkParams, methods } from "../src/gateway/methods.ts";

// bridge/contract.json against the list of everything the app sends and reads
// (Packages/PortalsKit/Tests/HermesBackendTests/Fixtures/contract-subset.json).

const root = fileURLToPath(new URL("../../", import.meta.url));
const subset = JSON.parse(readFileSync(`${root}Packages/PortalsKit/Tests/HermesBackendTests/Fixtures/contract-subset.json`, "utf8")) as {
  methods: Record<string, string[]>;
  events: string[];
  server_requests: string[];
  bridge: { features: string[]; events: Record<string, { feature?: string }>; methods: Record<string, { feature?: string; params: string[] }> };
};

test("contract.json is up to date (npm run contract rebuilds it)", () => {
  assert.equal(readFileSync(contractPath, "utf8"), contractText());
});

test("the bridge reads every param the app sends, and requires none it never sends", () => {
  for (const [name, keys] of Object.entries(subset.methods)) {
    const spec = methods[name];
    assert.ok(spec, `${name} is not handled`);
    for (const key of keys) assert.ok(key in spec.params, `${name}: ${key} is not read`);
    for (const key of spec.required ?? []) assert.ok(keys.includes(key), `${name}: requires ${key}, which the app never sends`);
  }
});

// Extensions the app does not use: for clients that manage threads as a whole
// (docs/fleet-plan.md), the net until the app's side of it is built (docs/net-plan.md, N2),
// and what the net's Macs say to each other (held_elsewhere).
const notForTheApp = ["fleet", "fleet_delta", "fleet_delta_positions", "fleet_pages", "net", "held_elsewhere", "tell_starters"];
const shapeGatedMethods = new Set([
  "commands.catalog", // Existing method; optional session_id is additive.
]);

test("the pre-session_id commands.catalog param spec ignores a newer app's optional session_id", () => {
  const previous = { ...methods["commands.catalog"], params: { profile: "string" as const } };
  assert.doesNotThrow(() => checkParams(previous, { profile: "droid", session_id: "new-app-thread" }));
});

test("the bridge offers every extension the app knows, and reads every param of the bridge-only methods", () => {
  assert.deepEqual([...bridgeFeatures].filter((feature) => !notForTheApp.includes(feature)).sort(), [...subset.bridge.features].sort());
  for (const [name, { feature, params }] of Object.entries(subset.bridge.methods)) {
    const spec = methods[name];
    assert.ok(spec, `${name} is not handled`);
    assert.ok(feature ? (bridgeFeatures as readonly string[]).includes(feature) : shapeGatedMethods.has(name),
      `${name}: feature ${feature} is not offered and the method has no explicit shape gate`);
    for (const key of params) assert.ok(key in spec.params, `${name}: ${key} is not read`);
    for (const key of spec.required ?? []) assert.ok(params.includes(key), `${name}: requires ${key}, which the app never sends`);
  }
});

test("every event and question the app reads is in the contract", () => {
  const contract = buildContract() as { "x-notifications": { name: string }[]; "x-server-requests": { name: string }[] };
  const events = new Set(contract["x-notifications"].map((event) => event.name));
  for (const name of subset.events) assert.ok(events.has(name), name);
  assert.deepEqual(contract["x-server-requests"].map((request) => request.name).sort(), [...subset.server_requests].sort());
  // Bridge events may be gated by a feature or recognized by their event shape.
  for (const [name, { feature }] of Object.entries(subset.bridge.events)) {
    assert.ok(events.has(name), name);
    if (feature) assert.ok((bridgeFeatures as readonly string[]).includes(feature), `${name}: feature ${feature} is not offered`);
    assert.ok(!subset.events.includes(name), `${name} is read from Hermes too`);
  }
});

test("scripts/check-contract.sh accepts bridge/contract.json", () => {
  const output = execFileSync("sh", [`${root}scripts/check-contract.sh`, contractPath], { encoding: "utf8" });
  assert.match(output, /^OK: every method, param, event and server request Portals uses is in this contract\.$/m);
});
