import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopDefaults } from "../src/providers/codex/options.ts";
import { CodexSession, type CodexHost } from "../src/providers/codex/session.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { Session } from "../src/sessions/session.ts";

const step = () => new Promise<void>((resolve) => setImmediate(resolve));
const settings = { model: "default", provider: "openai", reasoningEffort: "" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(subscribed = true) {
  const record: ThreadRecord = { id: "thread", agent: "codex", cwd: "/tmp", title: "Test", ...settings, createdAt: 0, updatedAt: 0, origin: "phone" };
  const core = new Session(record, { has: () => false } as unknown as Registry);
  let dispatch: (method: string, params: any) => Promise<any> = async () => ({});
  const host: CodexHost = {
    client: {
      call: (method, params) => dispatch(method, params),
      whenReady: async () => {}, respond() {}, respondError() {},
    },
    defaults: () => null,
    defaultsFor: async () => desktopDefaults({}),
    efforts: () => [],
    imagesDir: "/tmp",
    interruptGraceMs: 100,
    readyMs: 1000,
    nameThread() {}, forget() {},
    skill: async () => null,
  };
  const adapter = new CodexSession({ id: "thread", cwd: "/tmp", settings, title: "Test" }, core.sink, host, { applied: null, subscribed });
  await core.attach(adapter);
  await step();
  return { core, adapter, setCall: (call: typeof dispatch) => { dispatch = call; } };
}

for (const outcome of ["failed start", "successful start", "failed compact"] as const) {
  test(`a late Codex ${outcome} reply cannot end or adopt the next queued turn`, async () => {
    const { core, adapter, setCall } = await fixture();
    const first = deferred<void>(), second = deferred<void>();
    const sent: string[] = [];
    setCall(async (method) => {
      if (method === "turn/start" || method === "thread/compact/start") {
        sent.push(method);
        if (sent.length === 1) {
          await first.promise;
          if (outcome !== "successful start") throw new Error("the first reply timed out");
          return { turn: { id: "first" } };
        }
        await second.promise;
        return { turn: { id: "second" } };
      }
      return {};
    });
    try {
      core.submit(outcome === "failed compact" ? "/compact" : "first").begin?.();
      await step();
      core.submit("second", { queue: true });
      adapter.notification("turn/started", { turn: { id: "first" } });
      adapter.notification("turn/completed", { turn: { id: "first", status: "completed", items: [] } });
      await step();
      assert.equal(sent.length, 2);
      first.resolve();
      await step();
      assert.equal(core.isRunning, true);
      adapter.notification("turn/started", { turn: { id: "second" } });
      assert.equal(adapter.latestTurn(), "second", "the old reply must not adopt first or clear the new turn's starting state");
      second.resolve();
      await step();
      adapter.notification("turn/completed", { turn: { id: "second", status: "completed", items: [] } });
      assert.equal(core.isRunning, false);
    } finally { first.resolve(); second.resolve(); await step(); await core.close(); }
  });
}

for (const prompt of ["do not run after removal", "/compact"]) test(`closing Codex during subscription prevents ${prompt === "/compact" ? "compaction" : "the pending message"} from starting a daemon turn`, async () => {
  const { core, setCall } = await fixture(false);
  const resume = deferred<void>(), called = deferred<void>();
  const methods: string[] = [];
  setCall(async (method) => {
    methods.push(method);
    if (method === "thread/resume") {
      called.resolve();
      await resume.promise;
    }
    return method === "turn/start" ? { turn: { id: "unexpected" } } : {};
  });
  try {
    core.submit(prompt).begin?.();
    await called.promise;
    await core.close();
    resume.resolve();
    await step();
    assert.deepEqual(methods, ["thread/resume"]);
  } finally { resume.resolve(); await core.close(); }
});
