import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { OpenCode, isSessionNotFoundError } from "@opencode/client";
import { OpenCodeSession } from "../src/providers/opencode/session.ts";
import { OpenCodeTurn, recoveryBufferLimit } from "../src/providers/opencode/turn.ts";
import { OpenCodeForms } from "../src/providers/opencode/forms.ts";
import { NativeRevisions } from "../src/providers/opencode/revisions.ts";
import { OpenCodeApi } from "../src/providers/opencode/client.ts";
import type { Message, OpenCodeEvent } from "../src/providers/opencode/protocol.ts";
import type { ProviderEvent, SessionSink } from "../src/providers/types.ts";
import type { FormInfo, SessionInboxInfo } from "@opencode/client";

const id = "ses_round3";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const event = (type: string, data: object = {}): OpenCodeEvent => ({ id: "evt_round3", type, data: { sessionID: id, ...data } });
async function rig() {
  const events: ProviderEvent[] = [];
  const sink: SessionSink = { emit: (e) => events.push(e), ask: async () => ({ kind: "withdrawn", reason: "unused" }) };
  const api = {
    prompt: async () => ({ id: "u1" }),
    compact: async (_session: string, inputID?: string) => ({ id: inputID ?? "compact1" }),
    sessions: async () => [],
    active: async () => new Set<string>(),
    messages: async () => [] as Message[],
    inbox: async () => [] as SessionInboxInfo[],
    pendingPermissions: async () => [],
    forms: async () => [],
    session: async () => ({ id, time: { created: 1, updated: 3 } }),
    interrupt: async () => false,
    cancelInbox: async (_session: string, _inboxID: string) => {},
    commands: async () => [] as { name: string }[],
    command: async () => {},
  };
  const session = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "p/old", provider: "p", reasoningEffort: "" } }, sink,
    { api: async () => api as unknown as OpenCodeApi, bind() {}, forget() {}, contextOf() { return 1000; }, levelsOf() { return []; } },
    { info: { id, time: { created: 1, updated: 1 } }, messages: [], running: false },
  );
  session.attached();
  await tick();
  return { session, api, events };
}

test("round3: healthy SSE must not bypass an outstanding recovery backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const turn = new OpenCodeTurn(id);
  turn.attach();
  let reads = 0;
  const read = async () => { ++reads; throw new Error("HTTP unavailable while SSE is connected"); };
  const failed = () => {};
  turn.recover(read, failed);
  await turn.catchingUp;
  for (let n = 0; n < 4; ++n) {
    turn.receive(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "x" }), () => {}, (boundary) => turn.recover(read, failed, boundary));
    await turn.catchingUp;
  }
  const beforeBackoff = reads;
  turn.close();
  assert.equal(beforeBackoff, 1, "no timeout was advanced; four incoming frames must not start four immediate HTTP retries");
});

test("round3: failed snapshot must preserve an already captured model-selected event", async (t) => {
  const r = await rig();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  r.api.messages = async () => { throw new Error("one failed read"); };
  r.session.reconnected();
  // Captured by the first recovery batch, before the first REST read.
  r.session.event(event("session.model.selected", { model: { id: "new", providerID: "p", variant: "default" } }));
  await r.session.catchingUp();
  r.api.messages = async () => [];
  t.mock.timers.tick(100);
  await tick();
  await r.session.catchingUp();
  const chosen = r.session.settings().model;
  await r.session.close();
  assert.equal(chosen, "p/new", "a successful retry must not silently lose metadata from the failed batch");
});

test("round3: a sole desk input is not proof that a callback created it", async () => {
  const r = await rig();
  const callback = deferred<void>(), entered = deferred<void>();
  const deleted: string[] = [];
  let waiting: SessionInboxInfo[] = [];
  r.api.commands = async () => [{ name: "local-setting" }];
  // A native callback may update config or local state without admitting input.
  r.api.command = () => { entered.resolve(); return callback.promise; };
  r.api.inbox = async () => waiting;
  r.api.cancelInbox = async (_session, inboxID) => {
    deleted.push(inboxID);
    waiting = waiting.filter((item) => item.id !== inboxID);
  };
  r.session.startTurn({ text: "/local-setting", images: [] });
  await entered.promise;
  const desk: SessionInboxInfo = { id: "msg_desk_only", sessionID: id, type: "user", payload: { text: "Unrelated desk prompt" }, delivery: "queue", time: { created: 1 } };
  waiting = [desk];
  r.session.event(event("session.inbox.enqueued", { inboxID: desk.id, item: desk }));
  await r.session.interrupt();
  callback.resolve();
  await tick();
  await r.session.close();
  assert.deepEqual(deleted, [], "the callback admitted no work; Stop must not delete the terminal user's prompt");
});

test("round3: Stop must retain compact admission identity after a lost response", async () => {
  const r = await rig();
  const response = deferred<void>(), entered = deferred<void>();
  const deleted: string[] = [];
  let compactID = "";
  r.api.compact = async (_session, inputID) => { compactID = inputID ?? "msg_actual_compact"; entered.resolve(); await response.promise; throw new Error("lost compact response after durable admission"); };
  r.api.cancelInbox = async (_session, inboxID) => { deleted.push(inboxID); };
  r.session.startTurn({ text: "/compact", images: [] });
  await entered.promise;
  assert.match(compactID, /^msg_portals_turn_/, "native compaction must receive its stable identity before admission");
  const compact: SessionInboxInfo = { id: compactID, sessionID: id, type: "compaction", payload: {}, delivery: "queue", time: { created: 1 } };
  r.api.inbox = async () => [compact];
  r.session.event(event("session.inbox.enqueued", { inboxID: compact.id, item: compact }));
  await r.session.interrupt();
  response.resolve();
  await tick();
  const ended = r.events.find((e) => e.type === "turn.end");
  await r.session.close();
  assert.ok(deleted.includes(compact.id), `Stop ${JSON.stringify(ended)} left the real compact request queued; deleted ${JSON.stringify(deleted)}`);
});

test("round3: a newer empty form snapshot supersedes an older unseen form", async () => {
  const old = deferred<FormInfo[]>();
  let reads = 0;
  const cards: string[] = [];
  const api = { forms: async () => ++reads === 1 ? old.promise : [] } as unknown as OpenCodeApi;
  const forms = new OpenCodeForms(id, async () => api, {
    emit() {},
    ask: async (_card, signal) => {
      cards.push("old");
      return new Promise((resolve) => signal!.addEventListener("abort", () => resolve({ kind: "withdrawn", reason: "" }), { once: true }));
    },
  });
  const older = forms.reconcile();
  await tick();
  await forms.reconcile(); // The form has since been resolved, and the newer list is empty.
  old.resolve([{ id: "frm_unseen_old", sessionID: id, title: "Old request", fields: [{ key: "answer", type: "string" }] }]);
  await older;
  forms.close();
  assert.deepEqual(cards, [], "an unknown ID in an older list cannot override a newer authoritative absence");
});

test("round3: revision markers are cleared after all overlapping readers finish", () => {
  const revisions = new NativeRevisions();
  const first = revisions.start(), second = revisions.start();
  revisions.changed("frm_1");
  assert.equal(revisions.apply("frm_1", first), false);
  revisions.finish(first);
  assert.equal(revisions.apply("frm_1", second), false);
  revisions.finish(second);
  assert.equal((revisions as any).changedAt.size, 0);
  assert.equal((revisions as any).reads.size, 0);
});

test("round3: real client tagged SessionNotFound must enter independent deletion confirmation", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ _tag: "SessionNotFoundError", sessionID: id, message: "Session not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const native = new OpenCodeApi(OpenCode.make({ baseUrl: `http://127.0.0.1:${port}` }));
  const r = await rig();
  let confirmed = 0;
  try {
    await assert.rejects(native.session(id), (error) => isSessionNotFoundError(error), "the HTTP fixture uses the pinned client's recognized native error shape");
    r.api.messages = async () => { await native.session(id); return []; };
    r.api.session = async () => { ++confirmed; return native.session(id); };
    r.session.startTurn({ text: "Question", images: [] });
    await tick();
    r.session.reconnected();
    await r.session.catchingUp();
    const ended = r.events.find((e) => e.type === "turn.end");
    assert.equal(confirmed, 1, `the real client error must trigger the second native read; terminal event=${JSON.stringify(ended)}`);
    assert.ok(ended?.type === "turn.end" && /deleted in OpenCode/.test(ended.error ?? ""));
  } finally {
    await r.session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("round3: a superseded batch retains metadata before newer held frames", async () => {
  const turn = new OpenCodeTurn(id);
  const entered = deferred<void>(), release = deferred<void>();
  const batches: string[][] = [];
  turn.receive(event("session.renamed", { title: "Older" }), () => {}, () => {});
  turn.attach();
  const read = async (frames: OpenCodeEvent[]) => {
    batches.push(frames.map((frame) => String(frame.data.title)));
    if (batches.length === 1) { entered.resolve(); await release.promise; }
  };
  turn.recover(read, () => {});
  await entered.promise;
  turn.receive(event("session.renamed", { title: "Newer" }), () => {}, () => {});
  turn.recover(read, () => {}); // A new boundary invalidates the captured batch.
  release.resolve();
  await turn.catchingUp;
  assert.deepEqual(batches, [["Older"], ["Older", "Newer"]]);
  turn.close();
});

for (const change of ["stop", "close", "begin"] as const) test(`round3: ${change} discards captured obsolete metadata`, async () => {
  const turn = new OpenCodeTurn(id);
  const entered = deferred<void>(), release = deferred<void>();
  const batches: number[] = [];
  turn.receive(event("session.agent.selected", { agent: "plan" }), () => {}, () => {});
  turn.attach();
  turn.recover(async (frames) => {
    batches.push(frames.length);
    if (batches.length === 1) { entered.resolve(); await release.promise; throw new Error("obsolete read"); }
  }, () => {});
  await entered.promise;
  turn[change]();
  release.resolve();
  await turn.catchingUp;
  assert.deepEqual(batches, [1]);
  assert.equal(turn.hasHeld, false);
  turn.close();
});

test("round3: retaining failed batches still obeys the combined frame cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const turn = new OpenCodeTurn(id);
  const entered = deferred<void>(), release = deferred<void>();
  turn.receive(event("session.renamed", { title: "Captured" }), () => {}, () => {});
  turn.attach();
  turn.recover(async () => { entered.resolve(); await release.promise; throw new Error("read failed"); }, () => {});
  await entered.promise;
  for (let n = 0; n < recoveryBufferLimit.frames; ++n) turn.receive(event("session.text.delta", { delta: "x" }), () => {}, () => {});
  release.resolve();
  await turn.catchingUp;
  assert.ok((turn as any).held.length <= recoveryBufferLimit.frames);
  assert.ok((turn as any).heldBytes <= recoveryBufferLimit.bytes);
  assert.equal((turn as any).boundary, true);
  turn.close();
});

test("round3: metadata applied before a later read failure has effects only once", async (t) => {
  const r = await rig();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  r.api.forms = async () => { throw new Error("forms read failed after metadata"); };
  r.session.reconnected();
  r.session.event(event("session.agent.selected", { agent: "plan" }));
  r.session.event(event("session.renamed", { title: "New title" }));
  await r.session.catchingUp();
  assert.equal(r.session.mode().mode, "plan");
  r.api.forms = async () => [];
  t.mock.timers.tick(100);
  await tick();
  await r.session.catchingUp();
  assert.equal(r.events.filter((e) => e.type === "mode").length, 1);
  assert.equal(r.events.filter((e) => e.type === "title").length, 1);
  await r.session.close();
});

test("round3: a failed newer complete form list does not supersede an older successful one", async () => {
  const old = deferred<FormInfo[]>();
  let reads = 0, asked = 0;
  const api = { forms: async () => { if (++reads === 1) return old.promise; throw new Error("not a complete list"); } } as unknown as OpenCodeApi;
  const forms = new OpenCodeForms(id, async () => api, {
    emit() {},
    ask: async () => { ++asked; return { kind: "withdrawn", reason: "" }; },
  });
  const older = forms.reconcile();
  await tick();
  await assert.rejects(forms.reconcile());
  old.resolve([{ id: "frm_valid_old", sessionID: id, title: "Still waiting", fields: [{ key: "answer", type: "string" }] }]);
  await older;
  assert.equal(asked, 1);
  forms.close();
});

test("round3: deletion after interruption leaves one visible explanation, not a second completion", async () => {
  const r = await rig();
  r.session.startTurn({ text: "Question", images: [] });
  await tick();
  r.session.event(event("session.execution.interrupted"));
  let confirmations = 0;
  r.api.session = async () => { ++confirmations; throw Object.assign(new Error("gone"), { name: "SessionNotFoundError" }); };
  r.session.event(event("session.deleted"));
  await r.session.catchingUp();
  r.session.event(event("session.deleted"));
  assert.equal(confirmations, 2);
  assert.equal(r.events.filter((e) => e.type === "turn.end").length, 1);
  assert.equal(r.events.filter((e) => e.type === "notice" && /deleted in OpenCode/.test(e.text)).length, 1);
  await r.session.close();
});

test("round3: an unconfirmed deletion frame does not close a surviving thread", async () => {
  const r = await rig();
  let probes = 0;
  r.api.session = async () => {
    if (++probes === 1) throw Object.assign(new Error("restart not ready"), { name: "SessionNotFoundError" });
    return { id, time: { created: 1, updated: 3 } };
  };
  r.session.event(event("session.deleted"));
  await r.session.catchingUp();
  assert.equal(probes, 2);
  assert.equal(r.events.some((e) => e.type === "notice" && /deleted/.test(e.text)), false);
  r.session.startTurn({ text: "Still here", images: [] });
  await tick();
  assert.equal(r.events.some((e) => e.type === "turn.end" && e.retryable === false), false);
  await r.session.close();
});
