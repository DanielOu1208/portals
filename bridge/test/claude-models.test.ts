import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { claudeModels } from "../src/providers/claude/models.ts";
import { ClaudeProvider } from "../src/providers/claude/provider.ts";
import { fakeClaude, FakeFiles, FakeQuery } from "./claude-fixtures.ts";

// How Claude Code's models are listed in the app (models.ts), from part of the list
// Claude Code 2.1.293 answers `supportedModels()` with on a Max login.

const five = ["low", "medium", "high", "xhigh", "max"] as ModelInfo["supportedEffortLevels"];
const four = ["low", "medium", "high", "max"] as ModelInfo["supportedEffortLevels"];

function model(value: string, resolvedModel: string, displayName: string, description: string, levels = five): ModelInfo {
  return { value, resolvedModel, displayName, description, supportsEffort: levels!.length > 0, supportedEffortLevels: levels, supportsAdaptiveThinking: true };
}

const recorded: ModelInfo[] = [
  model("default", "claude-opus-5-5", "Default (recommended)", "Opus 5.5 · Best for everyday, complex tasks"),
  model("opus", "claude-opus-5-5", "Opus 5.5", "For complex work and everyday tasks"),
  model("fable", "claude-fable-5-1", "Fable 5.1", "For your toughest challenges"),
  model("sonnet", "claude-sonnet-5-5", "Sonnet 5.5", "Most efficient for simpler tasks"),
  model("haiku", "claude-haiku-5-5", "Haiku 5.5", "Fastest for quick answers"),
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
  model("claude-sonnet-5", "claude-sonnet-5", "Sonnet 5", "Efficient for routine tasks"),
  model("claude-opus-5", "claude-opus-5", "Opus 5", "Best for everyday, complex tasks"),
  model("claude-opus-4-6", "claude-opus-4-6", "Opus 4.6", "Best for everyday, complex tasks", four),
];

test("the default is named after the model it runs, which is not listed again; every model keeps its name and levels", () => {
  const { models, names, levels } = claudeModels(recorded, "claude-opus-5-5");
  assert.deepEqual(models, ["default", "fable", "sonnet", "haiku", "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-6"]);
  assert.deepEqual(names, {
    default: "Opus 5.5",
    opus: "Opus 5.5",
    fable: "Fable 5.1",
    sonnet: "Sonnet 5.5",
    haiku: "Haiku 5.5",
    "claude-haiku-4-5-20251001": "Haiku 4.5",
    "claude-sonnet-5": "Sonnet 5",
    "claude-opus-5": "Opus 5",
    "claude-opus-4-6": "Opus 4.6",
  });
  assert.deepEqual(levels.default, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(levels.opus, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(levels["claude-opus-4-6"], ["low", "medium", "high", "max"]);
  // Haiku 4.5 lists no levels and takes all of Claude's as thinking budgets.
  assert.deepEqual(levels["claude-haiku-4-5-20251001"], ["low", "medium", "high", "xhigh", "max"]);
});

test("a model setting other than Claude Code's recommended one names the default, with that model's levels", () => {
  // Claude Code's `default` entry still describes Opus 5.5; a thread naming no model runs on the setting.
  const sonnet = claudeModels(recorded, "claude-sonnet-5-5");
  assert.equal(sonnet.names.default, "Sonnet 5.5");
  assert.deepEqual(sonnet.models, ["default", "opus", "fable", "haiku", "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-6"]);
  const older = claudeModels(recorded, "claude-opus-4-6");
  assert.equal(older.names.default, "Opus 4.6");
  assert.deepEqual(older.levels.default, ["low", "medium", "high", "max"]);
  assert.ok(!older.models.includes("claude-opus-4-6") && older.models.includes("opus"));
  // A setting Claude Code lists no entry for goes by its id, and nothing is left out.
  const unlisted = claudeModels(recorded, "claude-opus-5-5[1m]");
  assert.equal(unlisted.names.default, "claude-opus-5-5[1m]");
  assert.deepEqual(unlisted.models, recorded.map((entry) => entry.value));
});

test("when Claude Code does not say what its settings come to, the default is its recommended model", () => {
  const { models, names } = claudeModels(recorded, null);
  assert.equal(names.default, "Opus 5.5");
  assert.ok(!models.includes("opus"));
  // Without an alias for it, the description says what it is.
  const alone = claudeModels([recorded[0], recorded[2]], null);
  assert.equal(alone.names.default, "Opus 5.5");
  assert.deepEqual(alone.models, ["default", "fable"]);
  // Without a description that says, its id.
  const bare = claudeModels([{ ...recorded[0], description: "Best for everyday, complex tasks" }], null);
  assert.equal(bare.names.default, "claude-opus-5-5");
});

test("a list without a default is listed whole, each model by its name", () => {
  const { models, names } = claudeModels(recorded.slice(1), "claude-opus-5-5");
  assert.deepEqual(models, recorded.slice(1).map((entry) => entry.value));
  assert.equal(names.opus, "Opus 5.5");
  assert.equal(names.default, undefined);
});

test("the provider asks its startup check which model the settings come to, and names the default after it", async () => {
  // A `model` setting of `sonnet`: `opus` is listed again, `sonnet` is the default's.
  const catalog = await fakeClaude({ appliedModel: "claude-sonnet-5-5" }).provider.models();
  assert.deepEqual(catalog.providers[0].models, ["default", "opus", "haiku", "claude-opus-4-6"]);
  assert.equal(catalog.names?.default, "Sonnet 5.5");
  assert.equal(catalog.model, "default");
  // A Claude Code that does not say: its recommended model.
  const silent = await fakeClaude({ appliedModel: null }).provider.models();
  assert.equal(silent.names?.default, "Opus 5.5");
  assert.ok(!silent.providers[0].models.includes("opus"));
  // One that refuses to say still lists its models.
  const refusing = new ClaudeProvider({
    settings: { path: "/nonexistent/claude", idleMinutes: 15, maxWarm: 6, apiKey: null, folder: "/tmp" },
    files: new FakeFiles(),
    agents: async () => [],
    query: (prompt, options) =>
      Object.assign(new FakeQuery(prompt, options), {
        getSettings: async (): Promise<never> => {
          throw new Error("Unsupported control request subtype: get_settings");
        },
      }),
  });
  const refused = await refusing.models();
  assert.deepEqual(refused.providers[0].models, ["default", "sonnet", "haiku", "claude-opus-4-6"]);
  assert.equal(refused.names?.default, "Opus 5.5");
});

test("an old check is asked again, so a model setting changed at the desk names the default", async () => {
  let now = 0;
  const options = { appliedModel: "claude-opus-5-5" as string | null, now: () => now };
  const { provider, queries } = fakeClaude(options);
  assert.equal((await provider.models()).names?.default, "Opus 5.5");
  options.appliedModel = "claude-sonnet-5-5";
  now += 9 * 60_000;
  assert.equal((await provider.models()).names?.default, "Opus 5.5");
  assert.equal(queries.length, 1);
  now += 2 * 60_000;
  // What the old check found answers at once, while a new one runs, without a session.
  assert.equal((await provider.models()).names?.default, "Opus 5.5");
  assert.equal(queries.length, 2);
  assert.equal(queries[1].options.persistSession, false);
  const deadline = Date.now() + 3000;
  let catalog = await provider.models();
  while (catalog.names?.default !== "Sonnet 5.5") {
    assert.ok(Date.now() < deadline, "the new check never named the default");
    await new Promise((resolve) => setTimeout(resolve, 5));
    catalog = await provider.models();
  }
  assert.deepEqual(catalog.providers[0].models, ["default", "opus", "haiku", "claude-opus-4-6"]);
  assert.equal(queries.length, 2);
});
