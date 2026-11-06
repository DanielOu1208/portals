import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { setLogLevel } from "../src/log.ts";
import { goneKept, longestLine, Scanner, type ScanMessage } from "../src/usage/scanner.ts";
import { UsageStore } from "../src/usage/store.ts";
import { historyHome, scanOnce } from "./usage-fixtures.ts";

// The scanner's cursors (src/usage/scanner.ts) with the store adding up what it tells
// (src/usage/store.ts): a file that grows is read from where it was, a half-written line
// waits for its end, a file that shrank or is another file is read again in place of what
// it gave, and a file that is gone keeps what it gave.

setLogLevel("silent");

const folder = "/Users/dana/code/app";

/** A Claude Code assistant line with one request. */
function claudeLine(id: string, input: number, output: number, at = "2026-11-05T09:00:00.000Z", content = "Done."): string {
  return `${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", id, type: "message", role: "assistant", content: [{ type: "text", text: content }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, requestId: `req_${id}`, timestamp: at, cwd: folder, sessionId: "66666666-6666-4666-8666-666666666666" })}\n`;
}

/** A home with one Claude Code session file, and a scanner and store over it. */
function ledger(home = realHome()) {
  const projects = join(home, ".claude", "projects", "-Users-dana-code-app");
  mkdirSync(projects, { recursive: true });
  let now = Date.parse("2026-11-06T12:00:00Z");
  const store = new UsageStore(join(home, "state", "usage"), { timeZone: "UTC" });
  const clock = () => now;
  let reader = new Scanner({ home, env: {}, now: clock });
  return {
    home,
    projects,
    file: join(projects, "66666666-6666-4666-8666-666666666666.jsonl"),
    store,
    advance(ms: number) {
      now += ms;
    },
    /** A scanner started again from the store's cursors, as after a restart. */
    restart() {
      reader = new Scanner({ home, env: {}, now: clock, cursors: store.cursors() });
    },
    async scan(): Promise<ScanMessage[]> {
      const messages: ScanMessage[] = [];
      await reader.scan((message) => {
        messages.push(message);
        store.apply(message, () => "elsewhere");
      });
      return messages;
    },
    total(agent = "claude") {
      const rows = store.dayRows("0000-01-01", "9999-12-31").filter((row) => row.agent === agent);
      return { input: rows.reduce((sum, row) => sum + row.input, 0), output: rows.reduce((sum, row) => sum + row.output, 0), requests: rows.reduce((sum, row) => sum + row.requests, 0) };
    },
  };
}

function realHome(): string {
  return mkdtempSync(join(tmpdir(), "portals-usage-scan-"));
}

const files = (messages: ScanMessage[]) => messages.filter((message): message is Extract<ScanMessage, { type: "file" }> => message.type === "file");

test("a file that grows is read from where the last scan stopped; a scan with nothing new reads nothing", async () => {
  const book = ledger();
  writeFileSync(book.file, claudeLine("msg_1", 10, 100));
  assert.equal(files(await book.scan())[0].requests.length, 1);
  appendFileSync(book.file, claudeLine("msg_2", 20, 200));
  const second = files(await book.scan());
  assert.deepEqual(second.map((file) => [file.replace, file.requests.map((request) => request.input)]), [[false, [20]]]);
  assert.deepEqual(book.total(), { input: 30, output: 300, requests: 2 });
  const third = await book.scan();
  assert.equal(files(third).length, 0);
  assert.deepEqual(third.find((message) => message.type === "done"), { type: "done", files: 1, read: 0, bytes: 0, ms: (third.find((message) => message.type === "done") as { ms: number }).ms });
});

test("a half-written last line waits for its end, and then counts once", async () => {
  const book = ledger();
  const line = claudeLine("msg_1", 10, 100);
  writeFileSync(book.file, line.slice(0, 40));
  await book.scan();
  assert.deepEqual(book.total(), { input: 0, output: 0, requests: 0 });
  appendFileSync(book.file, line.slice(40, 90));
  await book.scan();
  assert.deepEqual(book.total(), { input: 0, output: 0, requests: 0 });
  appendFileSync(book.file, line.slice(90));
  await book.scan();
  assert.deepEqual(book.total(), { input: 10, output: 100, requests: 1 });
  await book.scan();
  assert.deepEqual(book.total(), { input: 10, output: 100, requests: 1 });
});

test("a file that shrank is read again, and what it gave before is replaced, not added to", async () => {
  const book = ledger();
  writeFileSync(book.file, claudeLine("msg_1", 10, 100) + claudeLine("msg_2", 20, 200));
  await book.scan();
  writeFileSync(book.file, claudeLine("msg_3", 7, 70));
  const read = files(await book.scan());
  assert.equal(read[0].replace, true);
  assert.deepEqual(book.total(), { input: 7, output: 70, requests: 1 });
});

test("another file under the same name (a new inode) is read again in place of the old one; its requests it claimed before still count", async () => {
  const book = ledger();
  writeFileSync(book.file, claudeLine("msg_1", 10, 100));
  await book.scan();
  writeFileSync(`${book.file}.new`, claudeLine("msg_1", 10, 100) + claudeLine("msg_2", 20, 200));
  renameSync(`${book.file}.new`, book.file);
  const read = files(await book.scan());
  assert.equal(read[0].replace, true);
  assert.deepEqual(book.total(), { input: 30, output: 300, requests: 2 });
});

test("a file that is gone keeps what it gave, its record let go of a month later; one under another name is not read again", async () => {
  const book = ledger();
  writeFileSync(book.file, claudeLine("msg_1", 10, 100));
  await book.scan();
  const moved = join(book.projects, "77777777-7777-4777-8777-777777777777.jsonl");
  renameSync(book.file, moved);
  const afterMove = await book.scan();
  assert.deepEqual(afterMove.filter((message) => message.type === "moved").map((message) => (message as { to: string }).to), [moved]);
  assert.equal(files(afterMove).length, 0);
  assert.deepEqual(book.total(), { input: 10, output: 100, requests: 1 });
  rmSync(moved);
  const afterDelete = await book.scan();
  assert.equal(afterDelete.filter((message) => message.type === "gone").length, 1);
  assert.deepEqual(book.total(), { input: 10, output: 100, requests: 1 });
  // A copy of the gone file's requests, written while its record is kept, adds nothing.
  writeFileSync(book.file, claudeLine("msg_1", 10, 100));
  await book.scan();
  assert.deepEqual(book.total(), { input: 10, output: 100, requests: 1 });
  rmSync(book.file);
  await book.scan();
  book.advance(goneKept + 1);
  const later = await book.scan();
  assert.equal(later.filter((message) => message.type === "forget").length, 2);
  assert.deepEqual(book.total(), { input: 10, output: 100, requests: 1 });
  assert.deepEqual(book.store.cursors(), {});
});

test("cursors kept by the store go on after a restart: nothing is read twice", async () => {
  const book = ledger();
  writeFileSync(book.file, claudeLine("msg_1", 10, 100));
  await book.scan();
  book.store.save();
  const loaded = new UsageStore(join(book.home, "state", "usage"), { timeZone: "UTC" });
  loaded.load();
  assert.deepEqual(loaded.dayRows("2026-11-05", "2026-11-05"), book.store.dayRows("2026-11-05", "2026-11-05"));
  book.restart();
  appendFileSync(book.file, claudeLine("msg_1", 10, 100) + claudeLine("msg_2", 20, 200));
  await book.scan();
  assert.deepEqual(book.total(), { input: 30, output: 300, requests: 2 });
});

test("a Codex session compressed to .jsonl.zst in place of its .jsonl counts once, whether the copy comes before the original goes or after", async () => {
  for (const order of ["copy-then-delete", "together"] as const) {
    const home = historyHome(["codex"]);
    const book = ledger(home);
    const day = join(home, ".codex", "sessions", "2026", "11", "05");
    const name = "rollout-2026-11-05T10-00-00-01a1ab26-a900-7000-8000-00000000000a.jsonl";
    await book.scan();
    const before = book.total("codex");
    const bytes = readFileSync(join(day, name));
    writeFileSync(join(day, `${name}.zst`), zstdCompressSync(bytes));
    if (order === "copy-then-delete") {
      const both = files(await book.scan());
      assert.deepEqual(both.map((file) => [file.cursor.duplicate, file.requests.length]), [[true, 0]]);
      assert.deepEqual(book.total("codex"), before);
    }
    rmSync(join(day, name));
    const after = await book.scan();
    const read = files(after);
    assert.equal(read.length, 1, order);
    assert.equal(read[0].takeover.length, 1, order);
    assert.deepEqual(book.total("codex"), before, order);
  }
});

test("a long line that holds no usage, across many reads, is passed over; one past the longest is passed over whatever it holds", async () => {
  const book = ledger();
  const tool = `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(3 * 1024 * 1024) }] }, timestamp: "2026-11-05T09:00:00.000Z" })}\n`;
  const huge = claudeLine("msg_huge", 999, 999, undefined, "y".repeat(longestLine + 1024));
  writeFileSync(book.file, claudeLine("msg_1", 10, 100) + tool + huge + claudeLine("msg_2", 20, 200));
  await book.scan();
  assert.deepEqual(book.total(), { input: 30, output: 300, requests: 2 });
});

test("a file that cannot be read costs only itself, and is not tried again until it changes", async () => {
  const home = historyHome(["codex"]);
  const book = ledger(home);
  const broken = join(home, ".codex", "archived_sessions", "rollout-2026-11-01T00-00-00-broken.jsonl.zst");
  mkdirSync(join(home, ".codex", "archived_sessions"), { recursive: true });
  writeFileSync(broken, "not zstd at all");
  const first = await book.scan();
  assert.equal(first.filter((message) => message.type === "log").length, 1);
  assert.equal(book.total("codex").requests, 6);
  const second = await book.scan();
  assert.equal(second.filter((message) => message.type === "log").length, 0);
  assert.equal(files(second).length, 0);
});

test("the scanner tells the file it is about to read, and leaves a file it was told to avoid at that size", async () => {
  const book = ledger();
  writeFileSync(book.file, claudeLine("msg_1", 10, 100));
  const size = readFileSync(book.file).length;
  const avoided = new Scanner({ home: book.home, env: {}, avoid: { [book.file]: size } });
  const { messages } = await scanOnce(avoided);
  assert.equal(messages.filter((message) => message.type === "reading").length, 0);
  assert.equal(files(messages).length, 0);
  const told = await book.scan();
  assert.deepEqual(told.filter((message) => message.type === "reading"), [{ type: "reading", path: book.file, size }]);
});
