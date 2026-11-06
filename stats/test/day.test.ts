import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDay } from "../src/day.ts";
import { bodyLimit } from "../src/stats.ts";
import { testLimiter } from "./d1.ts";
import { dayBody, INSTALL, NOW, OWNER, post, server, usageRow } from "./helpers.ts";

// POST /v1/day: what a host may send, and that a day sent again replaces the one before.

const TODAY = "2026-11-06";

test("the plan's body is a day", () => {
  const day = parseDay(dayBody(), TODAY);
  assert.deepEqual(day, {
    day: "2026-11-05",
    install: INSTALL,
    owner: OWNER,
    version: "0.3.3",
    os: "darwin",
    turns: 42,
    portals: { iphone: 1, ipad: 0, mac: 1, other: 0 },
    usage: [{ agent: "claude", model: "claude-opus-5-5", requests: 120, input: 2100, output: 51000, cacheRead: 3900000, cacheWrite: 210000, reasoning: 0, usd: 12.34 }],
  });
  // A host in no net sends its install id as the owner; a day with no usage is a day too.
  assert.ok(parseDay(dayBody({ owner: INSTALL, usage: [] }), TODAY));
  // A model with no price has no dollars.
  assert.equal(parseDay(dayBody({ usage: [usageRow({ model: "other", usd: null })] }), TODAY)?.usage[0].usd, null);
});

test("anything else in the body refuses the whole day", () => {
  const refused: [string, Record<string, unknown>][] = [
    ["another version of the body", { v: 2 }],
    ["an unknown key", { name: "Dana" }],
    ["an install that is no UUID", { install: "dana-macbook" }],
    ["an upper-case install", { install: INSTALL.toUpperCase() }],
    ["an owner that is not a hash", { owner: "dana@example.com" }],
    ["a day that is no date", { day: "2026-02-30" }],
    ["a day not yet begun here", { day: "2026-11-07" }],
    ["a day older than 14 days", { day: "2026-10-22" }],
    ["a version with spaces", { version: "0.3.3 beta" }],
    ["an os with markup", { os: "<b>darwin</b>" }],
    ["negative turns", { turns: -1 }],
    ["fractional turns", { turns: 1.5 }],
    ["turns as text", { turns: "42" }],
    ["too many turns", { turns: 1e9 }],
    ["a device kind not known", { portals: { iphone: 1, ipad: 0, mac: 1, other: 0, watch: 1 } }],
    ["a device kind missing", { portals: { iphone: 1, ipad: 0, mac: 1 } }],
    ["usage as an object", { usage: {} }],
    ["65 usage rows", { usage: Array.from({ length: 65 }, (_, index) => usageRow({ model: `model-${index}` })) }],
    ["an agent with a path", { usage: [usageRow({ agent: "/Users/dana" })] }],
    ["a model with spaces", { usage: [usageRow({ model: "Dana's fine-tune" })] }],
    ["a model longer than 64", { usage: [usageRow({ model: "m".repeat(65) })] }],
    ["an unknown usage key", { usage: [usageRow({ folder: "/Users/dana/code/app" })] }],
    ["a usage key missing", { usage: [{ agent: "codex", model: "gpt-5.5-codex", requests: 1, input: 1, output: 1, cache_read: 0, cache_write: 0, reasoning: 0 }] }],
    ["infinite dollars", { usage: [usageRow({ usd: Infinity })] }],
    ["negative dollars", { usage: [usageRow({ usd: -1 })] }],
    ["dollars as text", { usage: [usageRow({ usd: "1" })] }],
    ["tokens past the cap", { usage: [usageRow({ input: 2e12 })] }],
  ];
  for (const [what, overrides] of refused) assert.equal(parseDay(dayBody(overrides), TODAY), null, what);
  assert.equal(parseDay(null, TODAY), null);
  assert.equal(parseDay([dayBody()], TODAY), null);
  assert.equal(parseDay(JSON.parse('{"__proto__": {"v": 1}}'), TODAY), null);
  // The oldest day taken, and today itself.
  assert.ok(parseDay(dayBody({ day: "2026-10-23" }), TODAY));
  assert.ok(parseDay(dayBody({ day: TODAY }), TODAY));
});

test("rows for the same agent and model are added together", () => {
  const day = parseDay(dayBody({ usage: [usageRow({ model: "other", usd: null }), usageRow({ model: "other", requests: 5, usd: 1 }), usageRow()] }), TODAY);
  assert.equal(day?.usage.length, 2);
  assert.deepEqual(day?.usage[0], { agent: "codex", model: "other", requests: 15, input: 2000, output: 1000, cacheRead: 16000, cacheWrite: 0, reasoning: 400, usd: 1 });
  // Added rows are held to the caps too.
  const big = usageRow({ input: 600_000_000_000 });
  assert.equal(parseDay(dayBody({ usage: [big, big] }), TODAY), null);
});

test("a day is kept, and sent again replaces the one before", async () => {
  const { db, handle } = server();
  const first = await handle(post(dayBody({ usage: [usageRow({ model: "gpt-5.5" }), usageRow({ model: "gpt-5.5-codex" })] })));
  assert.equal(first.status, 204);
  assert.equal(await first.text(), "");

  // The host sends it again with corrected counts and one model fewer.
  assert.equal((await handle(post(dayBody({ turns: 50, usage: [usageRow({ model: "gpt-5.5", requests: 11 })] })))).status, 204);
  const days = db.sqlite.prepare("SELECT * FROM days").all();
  assert.equal(days.length, 1);
  assert.equal(days[0].turns, 50);
  assert.equal(days[0].portals_iphone, 1);
  assert.equal(days[0].received_at, NOW);
  const usage = db.sqlite.prepare("SELECT model, requests FROM usage").all();
  assert.deepEqual(usage.map((row) => ({ ...row })), [{ model: "gpt-5.5", requests: 11 }]);

  // Another day, or another install's same day, is kept beside it.
  assert.equal((await handle(post(dayBody({ day: "2026-11-04" })))).status, 204);
  assert.equal((await handle(post(dayBody({ install: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" })))).status, 204);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM days").get() as { count: number }).count, 3);
});

test("a refused body gets a fixed answer, with nothing of it in it, and is not kept", async () => {
  const { db, handle } = server();
  for (const body of [dayBody({ name: "Dana" }), "not json", dayBody({ usage: [usageRow({ model: "dana secret model" })] })]) {
    const response = await handle(post(body));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { detail: "Not a day of Portals totals." });
  }
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM days").get() as { count: number }).count, 0);
});

test("a body past the limit is too long, declared or not", async () => {
  const { handle } = server();
  const long = JSON.stringify({ ...dayBody(), pad: "x".repeat(bodyLimit) });
  assert.equal((await handle(post(long))).status, 413);
  // Streamed with no length given.
  const bytes = new TextEncoder().encode(long);
  const stream = new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 4096) controller.enqueue(bytes.slice(at, at + 4096));
      controller.close();
    },
  });
  const request = new Request("https://stats.example/v1/day", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  assert.equal((await handle(request)).status, 413);
});

test("days are limited per address, and the address is only the limiter's key", async () => {
  const limiter = testLimiter(2);
  const { db, handle } = server({ dayLimit: limiter });
  assert.equal((await handle(post(dayBody()))).status, 204);
  assert.equal((await handle(post(dayBody()))).status, 204);
  const busy = await handle(post(dayBody()));
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "60");
  // Another address is not held up by the first.
  assert.equal((await handle(post(dayBody(), { "cf-connecting-ip": "198.51.100.4" }))).status, 204);
  assert.deepEqual(limiter.keys, ["203.0.113.7", "203.0.113.7", "203.0.113.7", "198.51.100.4"]);
  const kept = JSON.stringify([...db.sqlite.prepare("SELECT * FROM days").all(), ...db.sqlite.prepare("SELECT * FROM usage").all()]);
  assert.ok(!kept.includes("203.0.113.7") && !kept.includes("198.51.100.4"));
});

test("the day is checked against the server's own date", async () => {
  // The server's date is UTC: just after midnight on 2026-11-07 that day is taken (a host
  // far east of UTC may have finished it), the next one is not.
  const { handle } = server({ now: () => Date.parse("2026-11-07T00:05:00Z") });
  assert.equal((await handle(post(dayBody({ day: "2026-11-07" })))).status, 204);
  assert.equal((await handle(post(dayBody({ day: "2026-11-08" })))).status, 400);
});
