import "./environment.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HermesError, type Frame } from "../src/providers/hermes/client.ts";
import { HermesHost as HermesProviderHost } from "../src/providers/hermes/provider.ts";
import { HermesSession, noticeText, storedMessages, type HermesHost, type Loaded } from "../src/providers/hermes/session.ts";
import { TypedCommands } from "../src/providers/hermes/typed.ts";
import type { ProviderEvent, ThreadMode } from "../src/providers/types.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { Session } from "../src/sessions/session.ts";

// A Hermes thread's turn against a stand-in for Hermes's answers: a message steered in
// mid-turn, Hermes's notices, its own commands made a message of, and its session-only
// yolo as the thread's mode.

const settings = { model: "m", provider: "p", reasoningEffort: "" };
const step = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(options: { info?: Frame; mode?: ThreadMode; turnCommands?: string[] } = {}) {
  const record: ThreadRecord = { id: "stored", agent: "hermes", cwd: "/tmp", title: null, ...settings, createdAt: 0, updatedAt: 0, origin: "phone", ...(options.mode ? { mode: options.mode } : {}) };
  const core = new Session(record, { has: () => false } as unknown as Registry);
  const calls: { method: string; params: Frame }[] = [];
  let answer: (method: string, params: Frame) => Promise<unknown> = async () => ({});
  const host: HermesHost = {
    call: async <T>(method: string, params: Frame) => {
      calls.push({ method, params });
      return (await answer(method, params)) as T;
    },
    bind() {}, forget() {}, respond() {}, respondError() {},
    turnCommand: async (_profile, name) => (options.turnCommands ?? []).includes(name),
  };
  const loaded: Loaded = { session_id: "runtime", messages: [], info: options.info };
  const adapter = new HermesSession({ id: "stored", cwd: "/tmp", settings, ...(options.mode ? { mode: options.mode } : {}) }, "default", core.sink, host, loaded);
  await core.attach(adapter);
  await step();
  return { core, adapter, calls, answer: (call: typeof answer) => { answer = call; } };
}

/** Starts a turn of `text`, and Hermes's start of it. */
async function begin(core: Session, adapter: HermesSession, text: string, seq: number): Promise<void> {
  core.submit(text).begin?.();
  await step();
  adapter.event("message.start", seq, {});
}

test("a message sent while Hermes works is steered into its turn, and one Hermes says no to is a turn of its own after it", async () => {
  const { core, adapter, calls, answer } = await fixture();
  try {
    answer(async (method, params) => (method === "session.steer" ? { status: params.text === "and say why" ? "queued" : "rejected", text: params.text } : {}));
    await begin(core, adapter, "Check the build", 1);
    core.submit("and say why");
    await step();
    assert.deepEqual(calls.filter((call) => call.method === "session.steer").map((call) => call.params), [{ session_id: "runtime", text: "and say why", profile: "default" }]);
    assert.ok(core.messages.some((message) => message.role === "user" && message.text === "and say why"));

    core.submit("then stop");
    await step();
    assert.equal(calls.filter((call) => call.method === "session.steer").length, 2);
    adapter.event("message.complete", 2, { status: "complete", text: "Built, because…" });
    await step();
    // Hermes did not take it: it goes once the turn is over, as a message of its own.
    assert.deepEqual(calls.filter((call) => call.method === "prompt.submit").map((call) => call.params.text), ["Check the build", "then stop"]);
  } finally { await core.close(); }
});

test("a message sent before Hermes's agent has begun the turn, or while it compacts, waits for the turn's end, and a picture is never steered", async () => {
  const { core, adapter, calls, answer } = await fixture();
  let compacted = () => {};
  try {
    core.submit("Check the build").begin?.();
    await step();
    assert.equal(adapter.steerable(), false);
    adapter.event("message.start", 1, {});
    assert.equal(adapter.steerable(), true);
    assert.equal(await adapter.steer({ text: "look", images: [{ filename: "a.png", data: Buffer.from("a") }] }), "refused");
    adapter.event("message.complete", 2, { status: "complete", text: "Built." });

    answer((method) => (method === "session.compress" ? new Promise((resolve) => { compacted = () => resolve({ status: "compressed" }); }) : Promise.resolve({})));
    core.submit("/compact").begin?.();
    await step();
    assert.equal(adapter.steerable(), false);
    core.submit("and then?");
    await step();
    assert.equal(calls.filter((call) => call.method === "session.steer").length, 0);
    compacted();
    await step();
    await step();
    assert.deepEqual(calls.filter((call) => call.method === "prompt.submit").map((call) => call.params.text), ["Check the build", "and then?"]);
  } finally { compacted(); await core.close(); }
});

test("a steer whose answer is lost with the connection may have reached Hermes; one Hermes refused surely did not", async () => {
  const { core, adapter, answer } = await fixture();
  try {
    await begin(core, adapter, "Check the build", 1);
    answer(async () => { throw new Error("The connection to Hermes closed."); });
    assert.equal(await adapter.steer({ text: "more", images: [] }), false);
    answer(async () => { throw new HermesError(4010, "agent does not support steer"); });
    assert.equal(await adapter.steer({ text: "more", images: [] }), "refused");
  } finally { await core.close(); }
});

test("Hermes's notices are said once in the thread in the app's words, and its slow start is the status line until it clears", async () => {
  const events: ProviderEvent[] = [];
  const host: HermesHost = { call: async <T>() => ({}) as T, bind() {}, forget() {}, respond() {}, respondError() {} };
  const adapter = new HermesSession({ id: "stored", cwd: "/tmp", settings }, "default", { emit: (event) => { events.push(event); }, ask: async () => ({ kind: "withdrawn", reason: "test" }) }, host, { session_id: "runtime" });
  adapter.attached();
  await step();
  const low = { text: "⚠ Low disk (3.2 GB free) · /autoprune on|off|later", level: "warn", kind: "sticky", key: "prune" };
  adapter.event("notification.show", 1, low);
  adapter.event("notification.show", 2, low);
  adapter.event("notification.show", 3, { text: "✕ Credit access paused · run /topup to top up", level: "error", kind: "sticky", key: "credits.depleted" });
  adapter.startTurn({ text: "Hello", images: [] });
  adapter.event("notification.show", 4, { text: "Still starting the agent (tool discovery / model setup) — your message will be sent as soon as it's ready.", level: "info", kind: "agent", key: "build" });
  adapter.event("notification.clear", 5, { key: "build" });
  assert.deepEqual(events.filter((event) => event.type === "notice" || event.type === "status"), [
    { type: "notice", level: "warn", text: "Low disk (3.2 GB free)" },
    { type: "notice", level: "error", text: "Credit access paused" },
    { type: "status", text: "Still starting the agent (tool discovery / model setup) — your message will be sent as soon as it's ready." },
    { type: "status", text: "" },
  ]);
  assert.equal(noticeText("✓ Credit access restored"), "Credit access restored");
  assert.equal(noticeText("Stayed on m · switching to n needs confirmation"), "Stayed on m · switching to n needs confirmation");
  await adapter.close();
});

test("a Hermes command that becomes a message goes as that message, and one Hermes does not run fails the turn", async () => {
  const { core, adapter, calls, answer } = await fixture({ turnCommands: ["plan"] });
  try {
    answer(async (method, params) => (method === "command.dispatch" ? (params.arg === "" ? { type: "exec", output: "usage: /plan <task>" } : { type: "send", message: "Write a plan for: the move" }) : {}));
    await begin(core, adapter, "/plan the move", 1);
    assert.deepEqual(calls.filter((call) => call.method === "command.dispatch").at(-1)?.params, { session_id: "runtime", name: "plan", arg: "the move", profile: "default" });
    assert.equal(calls.filter((call) => call.method === "prompt.submit").at(-1)?.params.text, "Write a plan for: the move");
    adapter.event("message.complete", 2, { status: "complete", text: "Planned." });
    await step();

    core.submit("/plan").begin?.();
    await step();
    await step();
    assert.equal(core.isRunning, false);
    assert.ok(core.messages.some((message) => message.role === "assistant" && /Hermes did not run \/plan\./.test(message.text)));
    assert.equal(calls.filter((call) => call.method === "prompt.submit").length, 1);
  } finally { await core.close(); }
});

test("a Hermes thread's mode is Hermes's own for the session: kept as the thread's when another app changed it", async () => {
  const { core, adapter, calls, answer } = await fixture({ info: { yolo: true }, mode: "default" });
  try {
    assert.equal(core.mode()?.mode, "full");
    assert.equal(core.record.mode, "full");
    answer(async (method, params) => (method === "config.set" ? { key: "yolo", value: params.value === "on" ? "1" : "0", scope: "session" } : {}));
    await core.setMode("default");
    assert.deepEqual(calls.at(-1)?.params, { session_id: "runtime", key: "yolo", value: "off", scope: "session", profile: "default" });
    assert.equal(adapter.mode().mode, "default");
    await assert.rejects(adapter.setMode("ask"));
  } finally { await core.close(); }
});

test("on a profile that asks for no approvals, Hermes's yes for every session's yolo leaves the thread's mode as it was, and default comes to full", async () => {
  const { core, adapter, answer } = await fixture({ info: { yolo: true, approval_mode: "off" }, mode: "default" });
  try {
    assert.deepEqual(adapter.mode(), { mode: "default", defaultsTo: "full" });
    answer(async (method, params) => (method === "config.set" ? { key: "yolo", value: params.value === "on" ? "1" : "0", scope: "session" } : {}));
    await core.setMode("full");
    adapter.event("session.info", 1, { yolo: true, approval_mode: "off" });
    await core.setMode("default");
    adapter.event("session.info", 2, { yolo: true, approval_mode: "off" });
    assert.equal(core.mode()?.mode, "default");
    assert.equal(core.record.mode, "default");
    // The profile asks again: Hermes's word is the session's own once more.
    adapter.event("session.info", 3, { yolo: false, approval_mode: "manual" });
    assert.deepEqual(adapter.mode(), { mode: "default" });
  } finally { await core.close(); }
});

for (const after of ["a restart of the bridge", "a reconnect that lost events"] as const) {
  test(`a Hermes command made a message of reads back as the user typed it, not as Hermes's message, after ${after}`, async () => {
    const state = mkdtempSync(join(tmpdir(), "portals-hermes-typed-"));
    // The provider's own keeping, a new one for each run of the bridge.
    const provider = () => new HermesProviderHost({
      settings: { path: "/nonexistent/hermes", start: false, folder: state, logPath: join(state, "hermes-serve.log") },
      cachePath: join(state, "hermes.json"),
      connect: async () => { throw new Error("no Hermes here"); },
    });
    const expanded = "Write a plan for: the move";
    const written: Loaded = { session_id: "runtime", running: false, messages: [{ role: "user", text: expanded, timestamp: 1, row_id: 7 } as never, { role: "assistant", text: "Planned.", timestamp: 2 }] };
    const thread = (kept: HermesProviderHost) => {
      const record: ThreadRecord = { id: "stored", agent: "hermes", cwd: "/tmp", title: null, ...settings, createdAt: 0, updatedAt: 0, origin: "phone", ongoing: true };
      const core = new Session(record, { has: () => false } as unknown as Registry);
      const host: HermesHost = {
        call: async <T>(method: string) => {
          if (method === "command.dispatch") return { type: "send", message: expanded } as T;
          if (method === "prompt.submit") return { status: "streaming", user_row_id: 7 } as T;
          if (method === "session.resume") return written as T;
          if (method === "session.events.since") return { events: [], truncated: true, latest_seq: 9, open_requests: [] } as T;
          return {} as T;
        },
        bind() {}, forget() {}, respond() {}, respondError() {},
        botChatMark: async () => "mark",
        turnCommand: async (_profile, name) => name === "plan",
        typedCommands: (id) => kept.typedCommands(id),
        keepTyped: (id, row, text) => kept.keepTyped(id, row, text),
      };
      return { core, host };
    };
    const users = (core: Session) => core.messages.filter((message) => message.role === "user").map((message) => message.text);
    const { core, host } = thread(provider());
    const adapter = new HermesSession({ id: "stored", cwd: "/tmp", settings, ongoing: true }, "default", core.sink, host, { session_id: "runtime", messages: [] }, "mark");
    await core.attach(adapter);
    await step();
    let restarted: Session | null = null;
    try {
      await begin(core, adapter, "/plan the move", 1);
      assert.deepEqual(users(core), ["/plan the move"]);
      if (after === "a reconnect that lost events") {
        adapter.connectionLost();
        await adapter.reconnected(true);
        for (let tries = 0; tries < 100 && !core.messages.some((message) => message.role === "assistant" && message.text === "Planned."); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.ok(core.messages.some((message) => message.role === "assistant" && message.text === "Planned."), "Hermes's stored copy was taken");
        assert.deepEqual(users(core), ["/plan the move"]);
      } else {
        adapter.event("message.complete", 2, { status: "complete", text: "Planned." });
        await step();
        await core.close();
        const again = thread(provider());
        restarted = again.core;
        await again.core.attach(new HermesSession({ id: "stored", cwd: "/tmp", settings, ongoing: true }, "default", again.core.sink, again.host, written, "mark"));
        await step();
        assert.deepEqual(users(again.core), ["/plan the move"]);
      }
    } finally {
      await core.close();
      await restarted?.close();
      rmSync(state, { recursive: true, force: true });
    }
  });
}

test("every command made a message of reads back as typed after a restart of the bridge, past fifty of them, while Hermes still has their rows", () => {
  const state = mkdtempSync(join(tmpdir(), "portals-hermes-typed-"));
  try {
    const path = join(state, "hermes-commands.json");
    const typed = new TypedCommands(path);
    const messages: unknown[] = [];
    for (let row = 1; row <= 120; row++) {
      typed.keep("stored", row, `/plan step ${row}`);
      messages.push({ role: "user", text: `Write a plan for: step ${row}`, timestamp: row, row_id: row });
    }
    const users = storedMessages(messages, new TypedCommands(path).of("stored")).map((message) => (message as { text: string }).text);
    assert.equal(users.length, 120);
    assert.deepEqual(users.filter((text) => !text.startsWith("/plan")), []);
    assert.equal(users[0], "/plan step 1");
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("what was typed for a command is let go of once Hermes no longer has its row, and kept for a row stored after the read", async () => {
  const state = mkdtempSync(join(tmpdir(), "portals-hermes-typed-"));
  try {
    const kept = new HermesProviderHost({
      settings: { path: "/nonexistent/hermes", start: false, folder: state, logPath: join(state, "hermes-serve.log") },
      cachePath: join(state, "hermes.json"),
      connect: async () => { throw new Error("no Hermes here"); },
    });
    kept.keepTyped("stored", 3, "/plan compacted away");
    kept.keepTyped("stored", 5, "/plan still there");
    kept.keepTyped("stored", 9, "/plan stored after the read");
    // Compressing summarised row 3 away: Hermes's copy has rows 5 and 6.
    const loaded: Loaded = { session_id: "runtime", running: false, messages: [{ role: "compaction", text: "Summary", timestamp: 0 } as never, { role: "user", text: "Write a plan for: still there", timestamp: 1, row_id: 5 } as never, { role: "assistant", text: "Planned.", timestamp: 2, row_id: 6 } as never] };
    const record: ThreadRecord = { id: "stored", agent: "hermes", cwd: "/tmp", title: null, ...settings, createdAt: 0, updatedAt: 0, origin: "phone", ongoing: true };
    const core = new Session(record, { has: () => false } as unknown as Registry);
    const host: HermesHost = {
      call: async <T>() => ({}) as T,
      bind() {}, forget() {}, respond() {}, respondError() {},
      botChatMark: async () => "mark",
      typedCommands: (id) => kept.typedCommands(id),
      keepTyped: (id, row, text) => kept.keepTyped(id, row, text),
      forgetTyped: (id, rows) => kept.forgetTyped(id, rows),
    };
    await core.attach(new HermesSession({ id: "stored", cwd: "/tmp", settings, ongoing: true }, "default", core.sink, host, loaded, "mark"));
    await step();
    try {
      assert.deepEqual(core.messages.filter((message) => message.role === "user").map((message) => message.text), ["/plan still there"]);
      assert.deepEqual([...new TypedCommands(join(state, "hermes-commands.json")).of("stored")], [[5, "/plan still there"], [9, "/plan stored after the read"]]);
    } finally { await core.close(); }
  } finally { rmSync(state, { recursive: true, force: true }); }
});
