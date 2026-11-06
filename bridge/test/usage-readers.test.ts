import assert from "node:assert/strict";
import { readFileSync, renameSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { uuidTime } from "../src/usage/readers/codex.ts";
import { claudeProjects } from "../src/usage/readers/claude.ts";
import { historyHome, scanner, scanOnce, sum } from "./usage-fixtures.ts";

// Each agent's history read into requests (src/usage/readers/), from the fixtures: the
// counting rules each reader keeps, and the traps of each format.

const folder = "/Users/dana/code/app";
const s1 = "11111111-1111-4111-8111-111111111111";
const parent = "01a1ab26-a900-7000-8000-00000000000a";

test("Claude Code: a request written on several lines counts once, raised to its fullest line", async () => {
  const home = historyHome(["claude"]);
  const { requests } = await scanOnce(scanner(home));
  const claude = requests.filter((request) => request.agent === "claude");
  const opus = claude.filter((request) => request.model === "claude-opus-5-5" && request.session === s1 && !request.subagent);
  // msg_dana_a: its first line said 20 output tokens, its second 120: 120 is what counts.
  // msg_dana_b on the same model; the resumed file's copy of msg_dana_a adds nothing.
  assert.deepEqual(sum(opus), { input: 15, output: 160, cacheRead: 11000, cacheWrite: 1000, cacheWrite1h: 1000, reasoning: 15, requests: 2 });
  assert.ok(claude.every((request) => request.folder === folder));
});

test("Claude Code: a resumed session's copy of an earlier request counts nothing, its own requests count", async () => {
  const home = historyHome(["claude"]);
  const { requests } = await scanOnce(scanner(home));
  const resumed = requests.filter((request) => request.session === "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(sum(resumed), { input: 1, output: 5, cacheRead: 7000, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, requests: 1 });
});

test("Claude Code: a subagent counts with its parent session; the workflow journal, Claude Code's own notices and tool output are not usage", async () => {
  const home = historyHome(["claude"]);
  const { requests } = await scanOnce(scanner(home));
  const subagents = requests.filter((request) => request.subagent);
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0].session, s1);
  assert.equal(subagents[0].model, "claude-haiku-5-5");
  assert.ok(!requests.some((request) => request.model === "<synthetic>"));
  assert.ok(!requests.some((request) => request.input >= 123456 || request.input === 999999), "journal.jsonl and a tool's result were read as usage");
});

test("Claude Code: an advisor's requests are its own model's, and a usage that first gave no cache split is replaced by one that does", async () => {
  const home = historyHome(["claude"]);
  const { requests } = await scanOnce(scanner(home));
  const advisor = requests.filter((request) => request.model === "claude-fable-5-1");
  assert.deepEqual(sum(advisor), { input: 300, output: 60, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, requests: 0 });
  const sonnet = requests.filter((request) => request.model === "claude-sonnet-5-5");
  assert.deepEqual(sum(sonnet), { input: 30, output: 10, cacheRead: 3970, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, requests: 1 });
});

test("Claude Code's folder moves with CLAUDE_CONFIG_DIR", async () => {
  const home = historyHome(["claude"]);
  renameSync(join(home, ".claude"), join(home, "elsewhere"));
  assert.equal(claudeProjects({ home, env: { CLAUDE_CONFIG_DIR: join(home, "elsewhere") } }), join(home, "elsewhere", "projects"));
  assert.equal((await scanOnce(scanner(home))).requests.length, 0);
  const moved = await scanOnce(scanner(home, { env: { CLAUDE_CONFIG_DIR: join(home, "elsewhere") } }));
  assert.ok(moved.requests.length > 0);
});

test("Codex: a request is a rise of the running total, a repeat and a stale snapshot add nothing, a reset counts again", async () => {
  const home = historyHome(["codex"]);
  const { requests } = await scanOnce(scanner(home));
  const main = requests.filter((request) => request.session === parent && !request.subagent);
  // 1000/200/50/20, then +1500/1000/80/20, then +100/50/10/5, then 300/0/20/0 after compaction.
  assert.equal(main.length, 4);
  assert.deepEqual(sum(main), { input: 2900 - 1250, output: 160, cacheRead: 1250, cacheWrite: 0, cacheWrite1h: 0, reasoning: 45, requests: 4 });
  assert.ok(main.every((request) => request.model === "gpt-5.5" && request.folder === folder && request.originator === "portals-bridge"));
});

test("Codex: a fork's copy of its parent's turns counts nothing; its own turns count, with their model", async () => {
  const home = historyHome(["codex"]);
  const { requests } = await scanOnce(scanner(home));
  const fork = requests.filter((request) => request.session === "01a1ab79-0ec0-7000-8000-00000000000c");
  assert.equal(fork.length, 1);
  assert.deepEqual(sum(fork), { input: 1000, output: 100, cacheRead: 1000, cacheWrite: 0, cacheWrite1h: 0, reasoning: 20, requests: 1 });
  assert.equal(fork[0].model, "gpt-6.1-sol");
  assert.equal(fork[0].originator, "codex-tui");
  assert.equal(uuidTime(parent), Date.parse("2026-11-05T10:00:00.000Z"));
  assert.equal(uuidTime("6f1c2b9e-4a7d-4d55-9c1e-2f0b7a8e3d41"), undefined);
});

test("Codex: a thread Codex started itself counts with the session it was started from", async () => {
  const home = historyHome(["codex"]);
  const { requests } = await scanOnce(scanner(home));
  const subagent = requests.filter((request) => request.subagent);
  assert.equal(subagent.length, 1);
  assert.equal(subagent[0].session, parent);
  assert.deepEqual(sum(subagent), { input: 100, output: 30, cacheRead: 600, cacheWrite: 0, cacheWrite1h: 0, reasoning: 10, requests: 1 });
});

test("Codex: a session in both sessions/ and archived_sessions/, and as .jsonl.zst, counts once; CODEX_HOME moves it", async () => {
  const home = historyHome(["codex"]);
  const name = `rollout-2026-11-05T10-00-00-${parent}.jsonl`;
  const original = join(home, ".codex", "sessions", "2026", "11", "05", name);
  const bytes = readFileSync(original);
  const archived = join(home, ".codex", "archived_sessions");
  rmSync(archived, { recursive: true, force: true });
  writeFileSync(join(home, ".codex", "sessions", "copy.jsonl"), bytes);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(archived, { recursive: true });
  writeFileSync(join(archived, `${name}.zst`), zstdCompressSync(bytes));
  const { requests } = await scanOnce(scanner(home));
  assert.equal(requests.filter((request) => request.session === parent && !request.subagent).length, 4);
  renameSync(join(home, ".codex"), join(home, "codex-home"));
  const moved = await scanOnce(scanner(home, { env: { CODEX_HOME: join(home, "codex-home") } }));
  assert.equal(moved.requests.filter((request) => request.session === parent && !request.subagent).length, 4);
});

test("Pi: a forked session's copy of a reply counts once; compaction is billed too; the model comes from the session when an entry names none", async () => {
  const home = historyHome(["pi"]);
  const { requests } = await scanOnce(scanner(home));
  assert.equal(requests.length, 3);
  const first = requests.filter((request) => request.session === "33333333-3333-4333-8333-333333333333");
  assert.deepEqual(sum(first), { input: 912, output: 180, cacheRead: 2000, cacheWrite: 500, cacheWrite1h: 0, reasoning: 30, requests: 2 });
  assert.ok(first.every((request) => request.model === "claude-sonnet-5-5" && request.folder === folder));
  const fork = requests.filter((request) => request.session === "44444444-4444-4444-8444-444444444444");
  assert.deepEqual(fork.map((request) => [request.model, request.input, request.output, request.cacheRead]), [["gpt-5.5", 3, 20, 2500]]);
});

test("Droid: the settings' running total gives its rise at each change, at the time it was written", async () => {
  const home = historyHome(["factory"]);
  const settings = join(home, ".factory", "sessions", "-Users-dana-code-app", "55555555-5555-4555-8555-555555555555.settings.json");
  utimesSync(settings, new Date("2026-11-05T14:30:00Z"), new Date("2026-11-05T14:30:00Z"));
  const reader = scanner(home);
  const first = await scanOnce(reader);
  assert.deepEqual(first.requests.map((request) => [request.agent, request.session, request.model, request.folder, request.at]), [["droid", "55555555-5555-4555-8555-555555555555", "claude-opus-5-5", folder, Date.parse("2026-11-05T14:30:00Z")]]);
  assert.deepEqual(sum(first.requests), { input: 40, output: 900, cacheRead: 50000, cacheWrite: 3000, cacheWrite1h: 0, reasoning: 200, requests: 1 });
  const value = JSON.parse(readFileSync(settings, "utf8"));
  value.tokenUsage = { inputTokens: 50, outputTokens: 1000, cacheCreationTokens: 3000, cacheReadTokens: 60000, thinkingTokens: 250 };
  // Rewritten in place by a rename, as Droid does: another inode, the same session.
  writeFileSync(`${settings}.tmp`, JSON.stringify(value));
  renameSync(`${settings}.tmp`, settings);
  utimesSync(settings, new Date("2026-11-06T09:00:00Z"), new Date("2026-11-06T09:00:00Z"));
  const second = await scanOnce(reader);
  assert.deepEqual(second.requests.map((request) => [request.input, request.output, request.cacheRead, request.cacheWrite, request.reasoning, request.at]), [[10, 100, 10000, 0, 50, Date.parse("2026-11-06T09:00:00Z")]]);
  assert.equal(second.files[0].replace, false);
  assert.ok(statSync(settings).size > 0);
});
