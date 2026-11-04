import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexError } from "../src/providers/codex/client.ts";
import { historyFromThread } from "../src/providers/codex/history.ts";
import { readThread } from "../src/providers/codex/read.ts";
import type { CodexCalls } from "../src/providers/codex/session.ts";
import type { Thread, Turn } from "../src/providers/codex/types/index.ts";
import { fixtureCwd, recordedHistory } from "./codex-fixtures.ts";

function reader(call: (method: string, params: any) => Promise<any>): Pick<CodexCalls, "call"> {
  return { call };
}

function pages(turns: Turn[]) {
  const calls: { method: string; params: any }[] = [];
  const client = reader(async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") {
      assert.equal(params.includeTurns, false);
      return { thread: { id: "thread", status: { type: "idle" }, turns: [] } };
    }
    assert.equal(method, "thread/turns/list");
    assert.equal(params.sortDirection, "desc");
    const from = Number(params.cursor ?? 0);
    const size = Math.min(params.limit, 2);
    const data = structuredClone([...turns].reverse().slice(from, from + size));
    if (params.itemsView === "notLoaded") for (const turn of data) turn.items = [];
    else assert.equal(params.itemsView, "full");
    return { data, nextCursor: from + size < turns.length ? String(from + size) : null };
  });
  return { client, calls };
}

const history = () => ["tools", "reasoning", "steer", "interrupt", "compact"].flatMap((name) => recordedHistory(name).turns);

test("paged history keeps every turn, full tool result, reasoning and compaction in stored order", async () => {
  const turns = history();
  const { client, calls } = pages(turns);
  const thread = await readThread(client, "thread");
  assert.deepEqual(thread.turns, turns);
  assert.deepEqual(historyFromThread(thread, fixtureCwd, false), historyFromThread({ turns }, fixtureCwd, false));
  assert.ok(calls.filter((call) => call.method === "thread/turns/list").length > 1);
  assert.equal(calls.find((call) => call.method === "thread/read")?.params.includeTurns, false);
});

test("catch-up stops after all requested turns, including an older background command's turn", async () => {
  const turns = history();
  const recent = pages(turns);
  const last = turns.at(-1)!;
  assert.deepEqual((await readThread(recent.client, "thread", { through: [last.id] })).turns, turns.slice(-2));
  assert.equal(recent.calls.filter((call) => call.method === "thread/turns/list").length, 1);
  const background = pages(turns);
  const through = turns.at(-3)!.id;
  assert.deepEqual((await readThread(background.client, "thread", { through: [last.id, through] })).turns, turns.slice(-4));
  assert.equal(background.calls.filter((call) => call.method === "thread/turns/list").length, 2);
});

test("an absent catch-up anchor exhausts history; an empty thread still reads its metadata", async () => {
  const turns = history();
  const missing = pages(turns);
  assert.deepEqual((await readThread(missing.client, "thread", { through: ["removed"] })).turns, turns);
  const empty = pages([]);
  assert.deepEqual((await readThread(empty.client, "thread")).turns, []);
  assert.equal(empty.calls.length, 2);
});

test("a plan check reads only the newest turn without its items", async () => {
  const turns = history();
  const { client, calls } = pages(turns);
  const thread = await readThread(client, "thread", { latest: true });
  assert.deepEqual(thread.turns, [{ ...turns.at(-1), items: [] }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.limit, 1);
  assert.equal(calls[0].params.itemsView, "notLoaded");
});

for (const error of [new CodexError(-32601, "list_turns is not supported yet"), new CodexError(-32600, 'Invalid request: unknown variant `thread/turns/list`, expected `initialize`')]) {
  test(`an older server falls back to full history: ${error.message}`, async () => {
    const thread = recordedHistory("tools");
    const calls: string[] = [];
    const client = reader(async (method, params) => {
      calls.push(method);
      if (method === "thread/turns/list") throw error;
      assert.equal(params.includeTurns, true);
      return { thread };
    });
    assert.deepEqual(await readThread(client, "thread"), thread);
    assert.deepEqual(calls, ["thread/turns/list", "thread/read"]);
  });
}

test("unsupported paging after one page discards the partial history before falling back", async () => {
  const thread = recordedHistory("compact");
  let reads = 0;
  const client = reader(async (method) => {
    if (method === "thread/read") return { thread };
    if (reads++ === 0) return { data: [thread.turns.at(-1)], nextCursor: "older" };
    throw new CodexError(-32601, "list_turns is not supported yet");
  });
  assert.deepEqual(await readThread(client, "thread"), thread);
});

for (const error of [new CodexError(-32000, "connection dropped"), new CodexError(-32600, "thread not found"), new CodexError(-32602, "invalid cursor")]) {
  test(`a failed read is not retried with full hydration: ${error.message}`, async () => {
    const calls: string[] = [];
    const client = reader(async (method) => { calls.push(method); throw error; });
    await assert.rejects(readThread(client, "thread"), (caught) => caught === error);
    assert.deepEqual(calls, ["thread/turns/list"]);
  });
}

test("a repeated cursor fails instead of hanging or returning partial history", async () => {
  const client = reader(async () => ({ data: [], nextCursor: "same" }));
  await assert.rejects(readThread(client, "thread"), /repeated a history cursor/);
});

test("a turn completed between the newest page and metadata is refreshed before idle can mark it interrupted", async () => {
  const thread = recordedHistory("tools");
  const completed = thread.turns.at(-1)!;
  let reads = 0;
  const client = reader(async (method) => {
    if (method === "thread/read") return { thread: { ...thread, status: { type: "idle" }, turns: [] } };
    return { data: [reads++ === 0 ? { ...completed, status: "inProgress", items: completed.items.slice(0, 1) } : completed], nextCursor: null };
  });
  const result = await readThread(client, "thread");
  assert.equal(reads, 2);
  assert.deepEqual(historyFromThread(result, fixtureCwd, false).messages, historyFromThread(thread, fixtureCwd, false).messages);
});

test("a new turn begun between the refreshed page and metadata keeps its running state", async () => {
  const completed = recordedHistory("tools").turns[0];
  let reads = 0;
  const client = reader(async (method) => {
    if (method === "thread/read") return { thread: { status: { type: reads === 1 ? "idle" : "active" }, turns: [] } };
    return { data: [{ ...completed, id: reads++ === 0 ? "old" : "new", status: "inProgress", items: completed.items.slice(0, 1) }], nextCursor: null };
  });
  const result = await readThread(client, "thread");
  assert.equal(result.status.type, "active");
  assert.equal(historyFromThread(result, fixtureCwd, true).running?.turnId, "new");
});
