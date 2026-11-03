import assert from "node:assert/strict";
import { test } from "node:test";
import { FactoryDroidMessageSchema, type DroidStreamEvent } from "@factory/droid-sdk/node";
import { DroidStream } from "../src/providers/droid/stream.ts";
import type { Provider, ProviderSession, SessionSink, StoredMessage } from "../src/providers/types.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { Session, type Peer } from "../src/sessions/session.ts";
import type { LoggedEvent } from "../src/sessions/eventLog.ts";
import { createThread, startTestBridge, TestClient } from "./helpers.ts";

const settings = { model: "m", provider: "p", reasoningEffort: "" };
const agent: ProviderSession = {
  history: async () => [], settings: () => settings, startTurn() {}, interrupt: async () => false, close: async () => {},
  setModel: async () => ({ deferred: false }), setReasoning: async () => {},
};

function assistant(id: string, text: string): DroidStreamEvent {
  return { type: "assistant", text, message: FactoryDroidMessageSchema.parse({ id, role: "assistant", createdAt: 1, updatedAt: 1, content: [{ type: "text", text }] }) };
}

function standIn(attach: (sink: SessionSink) => void): Provider {
  return {
    profile: { name: "stand-in", kind: "fake", displayName: "Stand-in", description: "", model: "m", provider: "p" },
    start() {}, models: async () => ({ providers: [{ slug: "p", name: "P", models: ["m"] }], ...settings, reasoning: "" }),
    startSession: async (_options: unknown, sink: SessionSink) => { attach(sink); return agent; },
    close: async () => {},
  } as unknown as Provider;
}

test("Droid retries correct the actual Session, preserving the turn, tools, requests and survivor reasoning", async () => {
  const record: ThreadRecord = { id: "retry", agent: "stand-in", cwd: "/tmp", title: null, ...settings, createdAt: 0, updatedAt: 0, origin: "phone" };
  const core = new Session(record, { has: () => false } as unknown as Registry);
  await core.attach(agent);
  const events: LoggedEvent[] = [];
  core.follow({ isOpen: true, takesRequests: true, sessionResync: true, sendRequest() {}, sendEvent: (event) => events.push(event) } as Peer);
  core.submit("hello").begin?.();
  const history: StoredMessage[] = [];
  const stream = new DroidStream(history, (event) => core.sink.emit(event), "/tmp");
  stream.accept(assistant("kept", "Before tool."));
  stream.accept({ type: "tool_call", name: "Read", toolUseId: "read", input: { file_path: "/tmp/a" } });
  const approval = core.sink.ask({ kind: "approval", command: "next", choices: ["once", "deny"] });
  const [request] = core.requests.list();
  stream.accept({ type: "assistant_text_delta", messageId: "wrong", blockIndex: 0, text: "Wrong. " });
  stream.accept({ type: "thinking_text_delta", messageId: "wrong", blockIndex: 0, text: "Wrong thought." });
  stream.accept({ type: "assistant_text_delta", messageId: "good", blockIndex: 0, text: "Right. " });
  stream.accept({ type: "thinking_text_delta", messageId: "good", blockIndex: 0, text: "Good thought." });
  stream.accept({ type: "assistant_text_delta", messageId: "wrong", blockIndex: 0, text: "Wrong. " });
  const base = core.replayBase;
  stream.accept({ type: "assistant_message_retracted", messageId: "wrong" });
  assert.deepEqual(core.snapshot().inflight, { user: "hello", assistant: "Right. ", reasoning: "Good thought.",
    tools: [{ tool_id: "read", name: "read_file", args: { path: "/tmp/a", offset: undefined, limit: undefined } }] });
  assert.equal(core.isRunning, true);
  assert.deepEqual(core.requests.list().map((open) => open.id), [request.id]);
  assert.ok(core.replayBase > base);
  assert.equal(events.at(-1)?.type, "session.invalidated");
  assert.deepEqual(events.at(-1)?.payload, { replay_base: core.replayBase });
  stream.accept(assistant("good", "Right. "));
  stream.finish();
  core.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(events.findLast((event) => event.type === "message.complete")?.payload?.text, "Right. ");
  assert.deepEqual(core.messages.filter((message) => message.role === "assistant").map((message) => message.text), ["Before tool.", "Right. "]);
  assert.deepEqual(history.filter((message) => message.role === "assistant").map((message) => message.text), ["Before tool.", "Right. "]);
  assert.equal(core.messages.filter((message) => message.role === "tool").length, 1);
  await approval;
  await core.close();
});

test("negotiated invalidation keeps modern peers connected and rebases legacy reconnect snapshots", async () => {
  let sink!: SessionSink;
  const provider = standIn((target) => { sink = target; });
  const bridge = await startTestBridge({ providers: new Map([["stand-in", provider]]) });
  const modern = await TestClient.open(bridge, { capabilities: { session_resync: true } });
  const legacy = await TestClient.open(bridge);
  let reconnected: TestClient | undefined;
  try {
    assert.ok(modern.readyPayload.bridge.features.includes("session_resync"));
    const id = await createThread(modern, { profile: "stand-in" });
    const old = await legacy.call("session.resume", { session_id: id, replay_epoch: bridge.replayEpoch });
    await modern.call("prompt.submit", { session_id: id, text: "hello" });
    sink.emit({ type: "text", text: "Wrong." });
    sink.emit({ type: "assistant.replace", text: "Right.", reasoning: "Checked." });
    const invalidated = await modern.nextEvent("session.invalidated", id);
    assert.equal(await legacy.closed, 1012);
    assert.equal(modern.socket.readyState, modern.socket.OPEN);
    const resumed = await modern.call("session.resume", { session_id: id, replay_epoch: bridge.replayEpoch });
    assert.deepEqual(resumed.inflight, { user: "hello", assistant: "Right.", reasoning: "Checked." });
    assert.equal(resumed.replay_base, invalidated.payload.replay_base);
    reconnected = await TestClient.open(bridge);
    const whole = await reconnected.call("session.resume", { session_id: id, replay_epoch: bridge.replayEpoch, since: old.latest_seq, replay_base: old.replay_base });
    assert.equal(whole.replayed, undefined);
    assert.equal(whole.inflight.assistant, "Right.");
    sink.emit({ type: "text", text: " Still streaming." });
    assert.equal((await modern.nextEvent("message.delta", id)).payload.text, " Still streaming.");
  } finally { await modern.close(); await legacy.close(); await reconnected?.close(); await bridge.dispose(); }
});

test("resume sends its captured snapshot before microtask events, requests and a second invalidation", async () => {
  let sink!: SessionSink;
  const bridge = await startTestBridge({ providers: new Map([["stand-in", standIn((target) => { sink = target; })]]) });
  const client = await TestClient.open(bridge, { capabilities: { session_resync: true } });
  const snapshot = Session.prototype.snapshot;
  let covered: Promise<unknown> | undefined, later: Promise<unknown> | undefined;
  let core: Session | undefined;
  let armed = false;
  try {
    const id = await createThread(client, { profile: "stand-in" });
    await client.call("prompt.submit", { session_id: id, text: "hello" });
    sink.emit({ type: "text", text: "Before." });
    armed = true;
    Session.prototype.snapshot = function () {
      if (!armed || this.id !== id) return snapshot.call(this);
      armed = false;
      core = this;
      covered = sink.ask({ kind: "approval", command: "covered", choices: ["once", "deny"] });
      const answer = snapshot.call(this);
      const [request] = this.requests.list();
      queueMicrotask(() => {
        this.requests.withdraw(request.id, "resolved");
        later = sink.ask({ kind: "approval", command: "later", choices: ["once", "deny"] });
        sink.emit({ type: "assistant.replace", text: "Corrected.", reasoning: "Checked." });
        sink.emit({ type: "text", text: " After." });
      });
      return answer;
    };
    const response = await client.request("session.resume", { session_id: id, replay_epoch: bridge.replayEpoch }, "atomic-snapshot");
    const next = await client.find((frame) => frame.method === "approval" && frame.params.command === "later");
    await client.nextEvent("session.invalidated", id);
    const receipt = client.frames.indexOf(response);
    const before = client.frames.findIndex((frame) => frame.method === "approval" && frame.params.command === "covered");
    assert.ok(before < receipt);
    assert.ok(client.frames.indexOf(next) > receipt);
    assert.equal(response.result.open_requests.length, 1);
    assert.equal(response.result.inflight.assistant, "Before.");
    const cancellation = client.frames.findIndex((frame) => frame.params?.type === "request.cancel");
    const invalidation = client.frames.findIndex((frame) => frame.params?.type === "session.invalidated");
    assert.ok(cancellation > receipt);
    assert.ok(invalidation > receipt);
    assert.ok(client.frames[invalidation].params.seq > response.result.latest_seq);
    const repaired = await client.call("session.resume", { session_id: id, replay_epoch: bridge.replayEpoch });
    assert.deepEqual(repaired.inflight, { user: "hello", assistant: "Corrected. After.", reasoning: "Checked." });
    assert.equal(repaired.open_requests[0].id, next.id);
  } finally {
    Session.prototype.snapshot = snapshot;
    core?.requests.withdrawAll("test done");
    await client.close(); await bridge.dispose();
    await Promise.allSettled([covered, later]);
  }
});

test("retracting all Droid text restores the result-only fallback and keeps surviving thoughts", async () => {
  const history: StoredMessage[] = [], events: Parameters<SessionSink["emit"]>[0][] = [];
  const stream = new DroidStream(history, (event) => events.push(event), "/tmp");
  stream.accept({ type: "assistant_text_delta", messageId: "wrong", blockIndex: 0, text: "Wrong." });
  stream.accept({ type: "thinking_text_delta", messageId: "thought", blockIndex: 0, text: "Keep." });
  stream.accept({ type: "assistant_message_retracted", messageId: "wrong" });
  stream.accept({ type: "assistant_message_retracted", messageId: "wrong" });
  stream.accept({
    type: "result", subtype: "success", success: true, interrupted: false, error: null,
    sessionId: "sdk-session", durationMs: 1, tokenUsage: null, messages: [], text: "Final.", turnCount: 1,
  });
  stream.finish();
  assert.deepEqual(events.filter((event) => event.type === "assistant.replace"), [{ type: "assistant.replace", text: "", reasoning: "Keep." }]);
  assert.deepEqual(history.filter((message) => message.role === "assistant").map((message) => [message.text, message.reasoning]), [["", "Keep."], ["Final.", undefined]]);
});
