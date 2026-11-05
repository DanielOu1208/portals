import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { onTestCleanup, test } from "./opencode-test.ts";
import { OpenCodeStopNotes, restartsExecution } from "../src/providers/opencode/stopNotes.ts";
import { OpenCodeProvider } from "../src/providers/opencode/provider.ts";
import { settleOwned } from "../src/providers/opencode/shutdown.ts";
import type { Message } from "../src/providers/opencode/protocol.ts";
import { FakeOpenCode } from "./opencode-serve.ts";

const root = "ses_review_root", child = "ses_review_child", grandchild = "ses_review_grandchild";
const user = (id: string, at: number): Message => ({ id, type: "user", text: id, time: { created: at } });
const idle = (id: string, at: number): Message => ({ id, type: "idle", outcome: "interrupted", time: { created: at } });
const assistant = (id: string, at: number): Message => ({ id, type: "assistant", content: [], error: { type: "aborted", message: "Step interrupted" }, time: { created: at } });
const restart = (id: string, at: number): Message => ({ id, type: "synthetic", text: "Continue", metadata: { notice: "restart" }, time: { created: at } });
function rig(t: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), "opencode-review-five-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const logPath = join(folder, "opencode.log");
  return { folder, logPath, notes: new OpenCodeStopNotes(`${logPath}.stops.json`) };
}

for (const state of ["settled-child", "resumed-child-with-settled-root"] as const) {
  test(`round5: descendant provenance must control its replayed outcome: ${state}`, async (t) => {
    const r = rig(t), at = Date.now();
    const native = await FakeOpenCode.start();
    native.addSession({ id: root, location: { directory: r.folder }, time: { created: 1, updated: at } },
      [user("msg_root", at - 1000), idle("idle_root", at)]);
    native.addSession({ id: child, parentID: root, time: { created: 1, updated: at } }, []);
    const descendant = [user("msg_grandchild", at - 1000), assistant("assistant_grandchild", at - 500)];
    if (state === "settled-child") descendant.push(idle("idle_grandchild", at));
    else {
      descendant.push(restart("restart_grandchild", at + 1));
      native.active.add(grandchild);
    }
    native.addSession({ id: grandchild, parentID: child, time: { created: 1, updated: at } }, descendant);
    const execution = { sessionID: grandchild, openerID: "msg_grandchild", assistantID: "assistant_grandchild" };
    r.notes.remember(state === "settled-child"
      ? { serverIdentity: "owned-review", complete: true, settled: [grandchild], unsettled: [],
        executions: [{ ...execution, terminalID: "idle_grandchild" }] }
      : { serverIdentity: "owned-review", complete: false, settled: [root], unsettled: [grandchild],
        executions: [{ sessionID: root, openerID: "msg_root", terminalID: "idle_root" }, execution] });
    const provider = new OpenCodeProvider({
      settings: { path: "/nonexistent/opencode", mode: "own", start: false, folder: r.folder, logPath: r.logPath },
      locate: async () => ({ ...native.endpoint(), own: true }),
    });
    try {
      const session = await provider.resumeSession(
        { id: root, cwd: r.folder, readOnly: true, settings: { model: "", provider: "", reasoningEffort: "" } },
        { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "" }) },
      );
      assert.ok(native.calls.some((call) => call.path === `/api/session/${grandchild}/message`), "the fresh descendant history really was read");
      const text = (await session.history()).map((message) => "text" in message ? message.text : "").join("\n");
      await session.close();
      if (state === "settled-child") {
        assert.doesNotMatch(text, /could not confirm|may resume/,
          "the exact descendant terminal is present and complete=true, so its stop is not unconfirmed");
        assert.match(text, /1 subagent stopped/, "the confirmed descendant is reported, not silently dropped");
      } else {
        assert.match(text, /1 subagent was resumed by OpenCode/,
          "a settled root must not hide a descendant's independently verified actual restart");
        assert.match(text, /This turn stopped because/, "the accurate root note is preserved too");
      }
    } finally { await provider.close(); await native.close(); }
  });
}

test("round5 control: second restart is recognized with the latest captured restart opener", () => {
  const messages = [user("u1", 1), assistant("a1", 2), restart("r1", 3), assistant("a2", 4), restart("r2", 5)];
  const execution = { sessionID: root, openerID: "r1", assistantID: "a2" };
  assert.equal(restartsExecution(messages, execution), true);
  const boundaries: Message[] = [
    user("manual", 6),
    idle("ended", 6),
    { type: "compaction", id: "manual_compact", reason: "manual", status: "completed", time: { created: 6 } },
  ];
  for (const boundary of boundaries) {
    assert.equal(restartsExecution([...messages.slice(0, 4), boundary, messages[4]], execution), false);
    assert.equal(restartsExecution([...messages, boundary], execution), false);
  }
});

test("round5 control: truncated provenance does not guess an opener or block native interruption", async () => {
  let active = true;
  const calls: { path: string; limit: string | null }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    calls.push({ path: url.pathname, limit: url.searchParams.get("limit") });
    const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname === "/api/info") return send({ pid: process.pid, version: "2.2.5" });
    if (url.pathname === "/api/session/active") return send({ data: active ? { [root]: { type: "running" } } : {} });
    if (url.pathname.endsWith("/interrupt")) { active = false; return send({ interrupted: true }); }
    if (url.pathname.endsWith("/message")) {
      return url.searchParams.get("limit") === "200"
        ? send({ data: [assistant("a_old", Date.now()), user("possible_steer", Date.now())], cursor: { next: "older" } })
        : send({ data: [idle("idle_exact", Date.now())], cursor: {} });
    }
    response.writeHead(404); response.end();
  });
  onTestCleanup(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const result = await settleOwned({ url, headers: {}, own: true, pid: process.pid, serverIdentity: "review-owned" }, 700);
    assert.equal(result.complete, true);
    assert.equal(result.executions![0].openerID, undefined);
    assert.equal(result.executions![0].assistantID, "a_old");
    assert.equal(result.executions![0].terminalID, "idle_exact");
    const identity = calls.findIndex((call) => call.path.endsWith("/message") && call.limit === "200");
    const interrupt = calls.findIndex((call) => call.path.endsWith("/interrupt"));
    assert.ok(identity >= 0 && identity < interrupt);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
