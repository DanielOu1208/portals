import assert from "node:assert/strict";
import { test } from "./opencode-test.ts";
import { chooseModel } from "../src/fleet/fleet.ts";
import { modelKey, nativeModelID } from "../src/providers/opencode/models.ts";
import type { ModelCatalog, Provider } from "../src/providers/types.ts";

const catalog: ModelCatalog = {
  providers: [
    { slug: "anthropic", name: "Anthropic", models: ["anthropic/shared", "anthropic/only"] },
    { slug: "opencode", name: "OpenCode", models: ["opencode/shared"] },
  ],
  model: "opencode/shared", provider: "opencode", reasoning: "",
};
const agent = (kind: string) => ({ profile: { kind, displayName: kind } }) as Provider;

test("typed native model names use an explicit or current native provider, never an arbitrary duplicate", () => {
  assert.deepEqual(chooseModel(agent("opencode"), catalog, "shared", "anthropic"), { model: "anthropic/shared", provider: "anthropic" });
  assert.deepEqual(chooseModel(agent("opencode"), catalog, "shared", undefined, "opencode"), { model: "opencode/shared", provider: "opencode" });
  assert.deepEqual(chooseModel(agent("opencode"), catalog, "only", undefined), { model: "anthropic/only", provider: "anthropic" });
  assert.throws(() => chooseModel(agent("opencode"), catalog, "shared", undefined), /anthropic\/shared or opencode\/shared/);
  assert.deepEqual(chooseModel(agent("opencode"), catalog, "anthropic/shared", undefined, "opencode"), { model: "anthropic/shared", provider: "anthropic" });
});

test("exact raw model IDs still win, and no other provider gains OpenCode's alias handling", () => {
  const exact = { ...catalog, providers: [{ slug: "anthropic", name: "Anthropic", models: ["shared", "anthropic/shared"] }] };
  assert.deepEqual(chooseModel(agent("opencode"), exact, "shared", undefined), { model: "shared", provider: "anthropic" });
  for (const kind of ["claude", "codex", "pi", "cursor", "droid", "hermes"]) {
    assert.throws(() => chooseModel(agent(kind), catalog, "only", "anthropic"), /cannot run the model only/);
    assert.deepEqual(chooseModel(agent(kind), catalog, "anthropic/only", "anthropic"), { model: "anthropic/only", provider: "anthropic" });
  }
  assert.deepEqual(chooseModel(agent("claude"), { ...catalog, names: { opus: "Opus" } }, "opus", "anthropic"), { model: "opus", provider: "anthropic" });
});

test("qualified IDs round-trip native IDs containing slashes and accept legacy plain names", () => {
  assert.equal(nativeModelID(modelKey("anthropic/model", "openrouter"), "openrouter"), "anthropic/model");
  assert.equal(nativeModelID("model", "anthropic"), "model");
});

test("an explicit provider resolves slash-bearing native IDs before global names and rejects incompatible picker keys", () => {
  const listed: ModelCatalog = {
    ...catalog,
    providers: [
      { slug: "anthropic", name: "Anthropic", models: ["anthropic/shared"] },
      { slug: "openrouter", name: "OpenRouter", models: ["openrouter/anthropic/shared"] },
    ],
    names: { "anthropic/shared": "Anthropic Shared", "openrouter/anthropic/shared": "Router Shared" },
    levels: { "anthropic/shared": ["high"], "openrouter/anthropic/shared": ["low"] },
  };
  const selected = chooseModel(agent("opencode"), listed, "anthropic/shared", "openrouter");
  assert.deepEqual(selected, { model: "openrouter/anthropic/shared", provider: "openrouter" });
  assert.equal(listed.names?.[selected.model], "Router Shared");
  assert.deepEqual(listed.levels?.[selected.model], ["low"]);
  assert.throws(() => chooseModel(agent("opencode"), listed, "openrouter/anthropic/shared", "anthropic"), /with provider anthropic/);
});
