import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import { costOf, fetchPriceList, modelKey, Prices, readBundled, trimPrices, type PriceFile } from "../src/usage/prices.ts";

// The price table (src/usage/prices.ts): the shipped one, LiteLLM's list trimmed to the
// agents' models, a model found under the name its agent wrote, no price for one the list
// lacks, and a daily refresh that never trusts a bad answer.

setLogLevel("silent");

/** A list shaped like LiteLLM's: per token, by provider and mode, with others' models it should not keep. */
function list(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const models: Record<string, unknown> = {
    sample_spec: { input_cost_per_token: 0, litellm_provider: "one of the providers" },
    "claude-opus-5-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6, cache_creation_input_token_cost_above_1hr: 8e-6 },
    "claude-haiku-4-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost: 1.25e-6 },
    "claude-haiku-4-5-20251001": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost: 1.25e-6 },
    "claude-sonnet-4-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
    "gpt-5.5": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 5e-6, output_cost_per_token: 3e-5, cache_read_input_token_cost: 5e-7 },
    "openai/gpt-5.5": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 9e-6, output_cost_per_token: 9e-5 },
    "gpt-5.1-codex": { litellm_provider: "openai", mode: "responses", input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
    "gpt-image-2": { litellm_provider: "openai", mode: "image_generation", input_cost_per_token: 1e-5, output_cost_per_token: 4e-5 },
    "text-embedding-4": { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 1e-7, output_cost_per_token: 0 },
    "us.anthropic.claude-opus-5-5": { litellm_provider: "bedrock_converse", mode: "chat", input_cost_per_token: 4.4e-6, output_cost_per_token: 2.2e-5 },
    "xiaomi_mimo/mimo-v2.6-pro": { litellm_provider: "xiaomi_mimo", mode: "chat", input_cost_per_token: 4.35e-7, output_cost_per_token: 8.7e-7 },
    ...extra,
  };
  for (let index = 0; index < 60; index++) models[`gpt-filler-${index}`] = { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
  return models;
}

const folder = () => mkdtempSync(join(tmpdir(), "portals-usage-prices-"));
const bundled = (): PriceFile => trimPrices(list(), Date.parse("2026-11-01T00:00:00Z"));

test("the list is trimmed to the providers' own chat models, per million tokens, a dated name priced as its undated one dropped", () => {
  const file = bundled();
  assert.deepEqual(file.perMillion["claude-opus-5-5"], [4, 20, 0.2, 5, 8]);
  assert.deepEqual(file.perMillion["claude-sonnet-4-5"], [3, 15, null, null, null]);
  // A provider's own name wins over its prefixed one.
  assert.deepEqual(file.perMillion["gpt-5.5"], [5, 30, 0.5, null, null]);
  assert.equal(file.perMillion["mimo-v2.6-pro"]?.[0], 0.435);
  for (const gone of ["claude-haiku-4-5-20251001", "gpt-image-2", "text-embedding-4", "sample_spec", "us.anthropic.claude-opus-5-5"]) assert.equal(file.perMillion[gone], undefined, gone);
  assert.throws(() => trimPrices([], 0));
  assert.throws(() => trimPrices({ "claude-opus-5-5": list()["claude-opus-5-5"] }, 0), /does not look like/);
});

test("a model is found under the name its agent wrote; one the list lacks has no price", () => {
  const prices = new Prices({ stateDir: folder(), bundled: bundled() });
  assert.equal(modelKey("anthropic/claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(modelKey("us.anthropic.claude-opus-5-5-v1:0"), "claude-opus-5-5");
  assert.equal(modelKey("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(modelKey("Claude-Opus-5-5@20261001"), "claude-opus-5-5-20261001");
  for (const name of ["claude-opus-5-5", "claude-opus-5-5[1m]", "anthropic/claude-opus-5-5", "claude-opus-5-5-20261101", "us.anthropic.claude-opus-5-5-v1:0"]) {
    assert.equal(prices.price(name)?.input, 4e-6, name);
  }
  assert.equal(prices.price("claude-haiku-4-5-20251001")?.output, 5e-6);
  assert.equal(prices.price("claude-sonnet-4.5")?.input, 3e-6);
  assert.equal(prices.price("openrouter/openai/gpt-5.5")?.input, 5e-6);
  for (const unknown of ["unknown", "custom:MiMo-V2.5-Pro-0", "gpt-5.5-turbo-ultra", "claude-opus-9", ""]) assert.equal(prices.price(unknown), null, unknown);
  assert.equal(prices.cost("claude-opus-9", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }), null);
});

test("tokens are priced by type; the hour-long cache costs twice the input where the list does not say; reasoning is priced in the output only", () => {
  const counts = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, cacheWrite1h: 400_000, reasoning: 500_000, requests: 3 };
  assert.ok(Math.abs(costOf({ input: 4e-6, output: 2e-5, cacheRead: 2e-7, cacheWrite: 5e-6, cacheWrite1h: 8e-6 }, counts) - (4 + 20 + 0.2 + 0.6 * 5 + 0.4 * 8)) < 1e-9);
  assert.ok(Math.abs(costOf({ input: 3e-6, output: 1.5e-5 }, counts) - (3 + 15 + 3 + 0.6 * 3 + 0.4 * 6)) < 1e-9);
});

test("the shipped table loads, and has the agents' main models", () => {
  const file = readBundled();
  assert.ok(file);
  assert.ok(Object.keys(file.perMillion).length >= 50);
  const prices = new Prices({ stateDir: folder() });
  assert.ok(prices.at > 0);
  assert.ok(prices.price("claude-opus-5-5"));
  assert.ok(prices.price("gpt-5.5"));
});

test("the list is fetched again once a day at most, kept in state, and a failed, oversized or wrong answer leaves the table as it was", async () => {
  const stateDir = folder();
  let now = Date.parse("2026-11-06T12:00:00Z");
  let asked = 0;
  let answer: () => Response = () => new Response(JSON.stringify(list({ "claude-opus-5-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 3e-6, output_cost_per_token: 1e-5 } })));
  const fetcher = (async () => {
    asked++;
    return answer();
  }) as typeof fetch;
  const prices = new Prices({ stateDir, bundled: bundled(), clock: () => now, fetch: fetcher });
  assert.equal(await prices.refresh(), true);
  assert.equal(prices.price("claude-opus-5-5")?.input, 3e-6);
  assert.equal(prices.at, now);
  assert.ok(existsSync(join(stateDir, "usage", "prices.json")));
  assert.equal(await prices.refresh(), false);
  assert.equal(asked, 1);
  // Started again: the fetched table, newer than the shipped one, is the one used.
  const again = new Prices({ stateDir, bundled: bundled(), clock: () => now, fetch: fetcher });
  assert.equal(again.price("claude-opus-5-5")?.input, 3e-6);

  for (const bad of [() => new Response("not json"), () => new Response(JSON.stringify({ hello: "world" })), () => new Response("{}", { status: 500 }), () => new Response("x", { headers: { "content-length": String(64 * 1024 * 1024) } })]) {
    now += 25 * 60 * 60_000;
    answer = bad;
    assert.equal(await prices.refresh(), false);
    assert.equal(prices.price("claude-opus-5-5")?.input, 3e-6);
  }
  const saved = JSON.parse(readFileSync(join(stateDir, "usage", "prices.json"), "utf8"));
  assert.equal(saved.perMillion["claude-opus-5-5"][0], 3);
  await assert.rejects(fetchPriceList("https://example.invalid/list.json", (async () => { throw new Error("offline"); }) as typeof fetch), /offline/);
});
