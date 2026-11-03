import "./environment.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SpentStore, spentKept, withSpent } from "../src/sessions/spent.ts";
import { TurnTokens, claudeTokens, piTokens } from "../src/providers/spent.ts";
import type { StoredMessage } from "../src/providers/types.ts";

test("the bridge keeps the latest turns' tokens by the agent's id, one entry a turn, and lets a removed thread's go", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "spent-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new SpentStore(join(folder, "spent"));
  assert.deepEqual(store.read("th"), []);
  store.keep("th", { turn: "a", seconds: 6.2, tokens: 49_635 });
  store.keep("th", { turn: "a", seconds: 6.3, tokens: 49_700 });
  store.keep("th", { turn: "b", tokens: 10 });
  assert.deepEqual(store.read("th"), [
    { turn: "a", seconds: 6.3, tokens: 49_700 },
    { turn: "b", tokens: 10 },
  ]);
  for (let index = 0; index < spentKept + 5; index += 1) store.keep("th", { turn: `t${index}`, tokens: index + 1 });
  const kept = store.read("th");
  assert.equal(kept.length, spentKept);
  assert.equal(kept.at(-1)?.turn, `t${spentKept + 4}`);
  store.forget("th");
  assert.deepEqual(store.read("th"), []);
});

test("kept tokens go on the last message of their turn in the agent's history, which keeps what it says itself", () => {
  const history: StoredMessage[] = [
    { role: "user", text: "One", timestamp: 1 },
    { role: "assistant", text: "Done.", timestamp: 2, turn_usage: { seconds: 6.234 } },
    { role: "user", text: "Two", timestamp: 3 },
  ];
  const ends = new Map([["a", 2], ["b", 3], ["gone", 9]]);
  withSpent(history, [{ turn: "a", seconds: 6.2, tokens: 49_635 }, { turn: "b", seconds: 1 }, { turn: "gone", tokens: 5 }], (id) => ends.get(id));
  assert.deepEqual(history[1].turn_usage, { seconds: 6.234, tokens: 49_635 });
  assert.deepEqual(history[2].turn_usage, { seconds: 1 });
  assert.equal(history[0].turn_usage, undefined);
});

test("a stored conversation's turns add up their requests' tokens, in, out and cached, each once", () => {
  assert.equal(claudeTokens({ input_tokens: 6, cache_creation_input_tokens: 19_018, cache_read_input_tokens: 34_766, output_tokens: 658 }), 54_448);
  assert.equal(piTokens({ input: 10, output: 5, cacheRead: 100, cacheWrite: 1, totalTokens: 116 }), 116);
  assert.equal(piTokens({ totalTokens: 42 }), 42);
  const messages: StoredMessage[] = [{ role: "user", text: "Hi", timestamp: 1 }];
  const spent = new TurnTokens();
  spent.add(100);
  spent.add(Number.NaN);
  spent.close(messages);
  assert.deepEqual(messages[0].turn_usage, { tokens: 100 });
  // Nothing spent, nothing said.
  messages.push({ role: "user", text: "Again", timestamp: 2 });
  spent.close(messages);
  assert.equal(messages[1].turn_usage, undefined);
});
