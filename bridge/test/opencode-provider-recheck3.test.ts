import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "./opencode-test.ts";
import { OpenCodeStopNotes, stopNoteLimits } from "../src/providers/opencode/stopNotes.ts";
import { OpenCodeProvider } from "../src/providers/opencode/provider.ts";
import type { Message } from "../src/providers/opencode/protocol.ts";
import { FakeOpenCode } from "./opencode-serve.ts";

const id = "ses_review_four";
const stopped = {
  serverIdentity: "owned-review-server", settled: [id], unsettled: [], complete: true,
  executions: [{ sessionID: id, openerID: "msg_old_user", terminalID: "idle_shutdown" }],
};
const user = (id: string, text: string, created: number): Message => ({ id, type: "user", text, time: { created } });
const idle = (id: string, created: number): Message => ({ id, type: "idle", outcome: "interrupted", time: { created } });
function rig(t: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), "opencode-review-four-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const logPath = join(folder, "opencode.log");
  const notes = new OpenCodeStopNotes(`${logPath}.stops.json`);
  return { folder, logPath, notes };
}

for (const later of ["active", "interrupted"] as const) {
  test(`round4: a later manually started ${later} turn must not inherit the old shutdown reason`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const r = rig(t);
    const original = Date.now();
    r.notes.remember(stopped);
    t.mock.timers.tick(60_000);
    const laterTime = Date.now();
    const messages = [
      user("msg_old_user", "Original shutdown-interrupted task", original - 1000),
      idle("idle_shutdown", original),
      user("msg_new_manual", "A separate task manually started in OpenCode", laterTime),
      ...(later === "interrupted" ? [idle("idle_new_manual_stop", laterTime + 10)] : []),
    ];
    const native = await FakeOpenCode.start();
    native.addSession({ id, location: { directory: r.folder }, time: { created: original - 1000, updated: laterTime } }, messages);
    if (later === "active") native.active.add(id);
    const provider = new OpenCodeProvider({
      settings: { path: "/nonexistent/opencode", mode: "own", start: false, folder: r.folder, logPath: r.logPath },
      locate: async () => ({ ...native.endpoint(), own: true }),
    });
    try {
      const session = await provider.resumeSession(
        { id, cwd: r.folder, readOnly: true, settings: { model: "", provider: "", reasoningEffort: "" } },
        { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "" }) },
      );
      const history = await session.history();
      const notes = history.filter((message) => "text" in message && message.text.startsWith("Portals: "));
      const before = JSON.stringify(native.sessions.get(id)!.messages);
      await session.close();
      assert.equal(JSON.stringify(native.sessions.get(id)!.messages), before);
      const text = notes.map((message) => "text" in message ? message.text : "").join("\n");
      if (later === "active") {
        assert.doesNotMatch(text, /OpenCode resumed this turn/,
          "the fresh user opener proves this is a separate task, not automatic restart continuation");
      } else {
        const newUser = history.findIndex((message) => "text" in message && message.text.includes("A separate task"));
        const note = history.findIndex((message) => "text" in message && /This turn stopped because/.test(message.text));
        assert.ok(note < 0 || note < newUser,
          `the prior shutdown reason must not be inserted after the later user's interruption: ${JSON.stringify(history)}`);
      }
      const oldNote = history.findIndex((message) => "text" in message && /This turn stopped because/.test(message.text));
      const manual = history.findIndex((message) => "text" in message && message.text.includes("A separate task"));
      assert.ok(oldNote >= 0 && oldNote < manual, "the exact old terminal keeps its own shutdown annotation");
    } finally { await provider.close(); await native.close(); }
  });
}

test("round4 control: native restart of the recorded aborted execution gets one consumed resumed note", (t) => {
  const r = rig(t);
  const created = Date.now();
  r.notes.remember({ ...stopped, executions: [{ sessionID: id, openerID: "msg_old", assistantID: "msg_aborted" }] });
  const messages: Message[] = [
    user("msg_old", "Original task", created - 1000),
    { id: "msg_aborted", type: "assistant", content: [], error: { type: "aborted", message: "Step interrupted" }, time: { created } },
    { id: "msg_restart", type: "synthetic", text: "Continue", metadata: { notice: "restart" }, time: { created } },
  ];
  assert.match(r.notes.take(id, [], messages, new Set([id]))!.text, /resumed this turn/);
  assert.equal(new OpenCodeStopNotes(`${r.logPath}.stops.json`).take(id, [], [], new Set([id])), undefined);
});

test("round4 control: oversized multibyte IDs degrade to unknown and are not persisted", (t) => {
  const r = rig(t);
  const invalidID = "界".repeat(54); // 162 UTF-8 bytes, above the 160-byte limit.
  r.notes.remember({ ...stopped, settled: [invalidID] });
  const saved = JSON.parse(readFileSync(`${r.logPath}.stops.json`, "utf8"));
  assert.equal(saved.records[0].complete, false);
  assert.deepEqual(saved.records[0].settled, []);
  assert.match(r.notes.take("ses_unknown", [], [], new Set())!.text, /may resume/);
});

test("round4 control: retained close routing has a strict 256-target bound", async (t) => {
  const r = rig(t);
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent/opencode", mode: "own", start: false, folder: r.folder, logPath: r.logPath },
    locate: async () => { throw new Error("not used"); },
  });
  const p = provider as any;
  p.ownsServer = true;
  for (let i = 0; i < 300; ++i) {
    const session = { id: `ses_bound_${i}` };
    p.host.bind(session);
    p.host.forget(session);
  }
  assert.equal(p.sessions.size, 0);
  assert.equal(p.stopSessions.size, stopNoteLimits.ids);
  assert.equal(p.stopSessions.has("ses_bound_43"), false);
  assert.equal(p.stopSessions.has("ses_bound_44"), true);
  await provider.close();
  assert.equal(p.stopSessions.size, 0);
});

test("round4 control: nested replay inventory is bounded and truncation stays uncertain", async (t) => {
  const r = rig(t);
  const native = await FakeOpenCode.start();
  native.addSession({ id, location: { directory: r.folder }, time: { created: 1, updated: 1 } }, []);
  for (let i = 0; i < 1005; ++i) native.addSession({ id: `ses_nested_${i}`, parentID: id, time: { created: 1, updated: 1 } }, []);
  r.notes.remember({ ...stopped, settled: ["ses_not_in_first_page"] });
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent/opencode", mode: "own", start: false, folder: r.folder, logPath: r.logPath },
    locate: async () => ({ ...native.endpoint(), own: true }),
  });
  try {
    // Count the provider's API-method budget, independently of the stand-in's
    // deliberately tiny two-item HTTP pages and the client's max-page safeguard.
    const api = await (provider as any).api();
    let reads = 0;
    api.sessions = async (wanted: number, parent: string) => {
      ++reads;
      return parent === id ? [...native.sessions.values()].map((entry) => entry.info).filter((info) => info.parentID === id).slice(0, wanted) : [];
    };
    const session = await provider.resumeSession(
      { id, cwd: r.folder, readOnly: true, settings: { model: "", provider: "", reasoningEffort: "" } },
      { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "" }) },
    );
    assert.equal(reads, 1000, "one root API query plus at most 999 descendant API queries");
    assert.ok((await session.history()).some((message) => "text" in message && /may resume/.test(message.text)));
    await session.close();
  } finally { await provider.close(); await native.close(); }
});

test("round4 control: a broken nested lookup does not block loading or certify a complete inventory", async (t) => {
  const r = rig(t);
  const native = await FakeOpenCode.start();
  const at = Date.now();
  native.addSession({ id, location: { directory: r.folder }, time: { created: 1, updated: at } }, [idle("idle_old_root", at)]);
  native.addSession({ id: "ses_child", parentID: id, time: { created: 1, updated: at } }, []);
  r.notes.remember({ ...stopped, settled: ["ses_grandchild"] });
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent/opencode", mode: "own", start: false, folder: r.folder, logPath: r.logPath },
    locate: async () => ({ ...native.endpoint(), own: true }),
  });
  try {
    const api = await (provider as any).api();
    const sessions = api.sessions.bind(api);
    api.sessions = async (wanted: number, parent: string) => {
      if (parent === "ses_child") throw new Error("unavailable child inventory");
      return sessions(wanted, parent);
    };
    const session = await provider.resumeSession(
      { id, cwd: r.folder, readOnly: true, settings: { model: "", provider: "", reasoningEffort: "" } },
      { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "" }) },
    );
    assert.ok((await session.history()).some((message) => "text" in message && /may resume/.test(message.text)));
    await session.close();
  } finally { await provider.close(); await native.close(); }
});
