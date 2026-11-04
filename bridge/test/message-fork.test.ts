import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Provider, SessionOptions, SessionSink, StoredMessage, ThreadMode } from "../src/providers/types.ts";
import { createThread, isEvent, runTurn, startTestBridge, TestClient } from "./helpers.ts";

function agent() {
  const histories = new Map<string, StoredMessage[]>();
  const sinks = new Map<string, SessionSink>();
  const resumed: SessionOptions[] = [];
  const forks: { id: string; checkpoint: string; before: boolean }[] = [];
  let wait: Promise<void> | undefined;
  let stopping = async () => false;
  let resumedWait: Promise<void> | undefined;
  let forkId: string | undefined;
  let forkEntered!: () => void;
  const forkStarted = new Promise<void>((resolve) => { forkEntered = resolve; });
  let resumeEntered!: () => void;
  const resumeStarted = new Promise<void>((resolve) => { resumeEntered = resolve; });
  let automatic = true;
  let after = 0;
  const provider: Provider = {
    profile: { name: "fake", kind: "fake", displayName: "Test agent", description: "", model: "test", provider: "test" },
    supportsModes: true,
    models: async () => ({ providers: [{ slug: "test", name: "Test", models: ["test"] }], model: "test", provider: "test", reasoning: "low" }),
    async startSession(options, sink) { return session(options, sink); },
    async resumeSession(options, sink) { resumed.push(options); resumeEntered(); await resumedWait; return session(options, sink); },
    async forkAt(id, checkpoint, before) {
      forks.push({ id, checkpoint, before });
      forkEntered();
      await wait;
      const history = histories.get(id) ?? [];
      const index = history.findIndex((message) => message.role === "user" && message.checkpoint?.id === checkpoint);
      const next = history.findIndex((message, at) => at > index && message.role === "user" && message.display_kind !== "steer");
      const fork = forkId ?? randomUUID();
      histories.set(fork, structuredClone(history.slice(0, before ? index : next < 0 ? undefined : next)));
      return { id: fork, cwd: optionsFor(id).cwd, title: "Copy", settings: optionsFor(id).settings };
    },
  };
  const optionsById = new Map<string, SessionOptions>();
  function optionsFor(id: string) { return optionsById.get(id)!; }
  function session(options: SessionOptions, sink: SessionSink) {
    optionsById.set(options.id, options);
    let mode: ThreadMode = options.mode ?? "default";
    sinks.set(options.id, sink);
    histories.set(options.id, histories.get(options.id) ?? []);
    return {
      history: async () => structuredClone(histories.get(options.id)!),
      settings: () => options.settings,
      startTurn(prompt: { text: string }) {
        const history = histories.get(options.id)!;
        history.push({ role: "user", text: prompt.text, timestamp: ++after });
        if (automatic) setImmediate(() => finish(options.id));
      },
      steer: async (prompt: { text: string }) => {
        histories.get(options.id)!.push({ role: "user", text: prompt.text, timestamp: ++after, display_kind: "steer" });
        return true;
      },
      interrupt: async () => false,
      stopping: () => stopping(),
      mode: () => ({ mode }), setMode: async (value: ThreadMode) => { mode = value; },
      setModel: async () => ({ deferred: false }), setReasoning: async () => {}, close: async () => {},
    };
  }
  function finish(id: string) {
    const history = histories.get(id)!;
    const opener = history.findLast((message) => message.role === "user" && message.display_kind !== "steer")!;
    const checkpoint = { id: `native-${after}`, can_fork: true, can_edit: true };
    if (opener.role === "user") opener.checkpoint = checkpoint;
    history.push({ role: "assistant", text: "Done", timestamp: ++after });
    sinks.get(id)!.emit({ type: "text", text: "Done" });
    sinks.get(id)!.emit({ type: "checkpoint", checkpoint });
    sinks.get(id)!.emit({ type: "turn.end", status: "complete" });
  }
  return {
    provider, forks, resumed, histories, finish, forkStarted, resumeStarted,
    hold: (pending: Promise<void>) => { wait = pending; }, manual: () => { automatic = false; },
    onStopping: (work: () => Promise<boolean>) => { stopping = work; },
    holdResume: (pending: Promise<void>, id: string) => { resumedWait = pending; forkId = id; },
  };
}

test("message fork follows a new thread, retains policy and copies the exact selected boundary", async (t) => {
  const native = agent();
  const bridge = await startTestBridge({ providers: new Map([["fake", native.provider]]) });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const id = await createThread(client);
  await client.call("config.set", { session_id: id, key: "reasoning", value: "high" });
  await client.call("session.set_mode", { session_id: id, mode: "ask" });
  await runTurn(client, id, "Repeated prompt");
  await runTurn(client, id, "Repeated prompt");
  const original = await client.call("session.resume", { session_id: id });
  const first = original.messages[0].checkpoint.id;
  const second = original.messages[2].checkpoint.id;
  assert.notEqual(first, second);
  const copy = await client.call("session.fork", { session_id: id, checkpoint_id: first, before: false });
  assert.notEqual(copy.session_id, id);
  assert.equal(copy.stored_session_id, copy.session_id);
  const through = await client.call("session.resume", { session_id: copy.session_id });
  assert.equal(through.messages.length, 2);
  assert.equal(native.resumed.at(-1)?.settings.reasoningEffort, "high");
  assert.equal(native.resumed.at(-1)?.mode, "ask");
  assert.equal(through.info.cwd, original.info.cwd);
  const edit = await client.call("session.fork", { session_id: id, checkpoint_id: first, before: true });
  assert.deepEqual((await client.call("session.resume", { session_id: edit.session_id })).messages, []);
  const laterEdit = await client.call("session.fork", { session_id: id, checkpoint_id: second, before: true });
  assert.equal((await client.call("session.resume", { session_id: laterEdit.session_id })).messages.length, 2);
  assert.deepEqual((await client.call("session.resume", { session_id: id })).messages, original.messages);
  assert.deepEqual(native.forks.map(({ checkpoint, before }) => ({ checkpoint, before })), [
    { checkpoint: first, before: false }, { checkpoint: first, before: true }, { checkpoint: second, before: true },
  ]);
});

test("live checkpoints name the opener even after steering and precede completion", async (t) => {
  const native = agent();
  native.manual();
  const bridge = await startTestBridge({ providers: new Map([["fake", native.provider]]) });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const id = await createThread(client);
  await client.call("prompt.submit", { session_id: id, text: "Open" });
  await client.call("prompt.submit", { session_id: id, text: "Steer" });
  const busy = await client.request("session.fork", { session_id: id, checkpoint_id: "missing", before: false });
  assert.equal(busy.error.code, -32602);
  assert.equal(native.forks.length, 0);
  native.finish(id);
  await client.next((frame) => isEvent(frame, "message.complete", id));
  const events = client.events(id);
  const checkpointAt = events.findIndex((event) => event.type === "message.checkpoint");
  assert.ok(checkpointAt >= 0 && checkpointAt < events.findIndex((event) => event.type === "message.complete"));
  const snapshot = await client.call("session.resume", { session_id: id });
  assert.ok(snapshot.messages[0].checkpoint);
  assert.equal(snapshot.messages.find((message: any) => message.text === "Steer").checkpoint, undefined);
});

test("fork rejects stale, unfollowed and malformed requests before native work", async (t) => {
  const native = agent();
  const bridge = await startTestBridge({ providers: new Map([["fake", native.provider]]) });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  const other = await TestClient.open(bridge);
  t.after(async () => { await client.close(); await other.close(); });
  const id = await createThread(client);
  await runTurn(client, id, "Open");
  for (const params of [
    { session_id: id, checkpoint_id: "missing", before: false },
    { session_id: id, checkpoint_id: "missing" },
    { session_id: id, checkpoint_id: "missing", before: "false" },
  ]) assert.equal((await client.request("session.fork", params)).error.code, -32602);
  assert.ok((await other.request("session.fork", { session_id: id, checkpoint_id: "missing", before: false })).error);
  assert.equal(native.forks.length, 0);
});

test("an in-flight fork holds its source against sends, settings, removal and another fork", async (t) => {
  const native = agent();
  let release!: () => void;
  native.hold(new Promise<void>((resolve) => { release = resolve; }));
  const bridge = await startTestBridge({ providers: new Map([["fake", native.provider]]) });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const id = await createThread(client);
  await runTurn(client, id, "Open");
  const snapshot = await client.call("session.resume", { session_id: id });
  const params = { session_id: id, checkpoint_id: snapshot.messages[0].checkpoint.id, before: false };
  const pending = client.call("session.fork", params);
  // The socket processes this next request only after the first call acquired its hold.
  assert.ok((await client.request("prompt.submit", { session_id: id, text: "Wait" })).error);
  assert.ok((await client.request("config.set", { session_id: id, key: "reasoning", value: "high" })).error);
  assert.ok((await client.request("thread.delete", { thread: id })).error);
  assert.equal((await client.request("session.fork", params)).error.code, -32602);
  release();
  await pending;
  assert.equal(native.forks.length, 1);
  await runTurn(client, id, "Source still works");
});

test("removal rechecks a fork that started while the native stop check waited", async (t) => {
  const native = agent();
  const bridge = await startTestBridge({ providers: new Map([["fake", native.provider]]) });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const id = await createThread(client);
  await runTurn(client, id, "Open");
  const snapshot = await client.call("session.resume", { session_id: id });
  let reached!: () => void;
  const checking = new Promise<void>((resolve) => { reached = resolve; });
  let releaseStop!: () => void;
  const stop = new Promise<void>((resolve) => { releaseStop = resolve; });
  let first = true;
  native.onStopping(async () => {
    if (first) { first = false; reached(); await stop; }
    return false;
  });
  let releaseFork!: () => void;
  native.hold(new Promise<void>((resolve) => { releaseFork = resolve; }));
  const removal = client.request("thread.delete", { thread: id });
  await checking;
  const copy = client.call("session.fork", { session_id: id, checkpoint_id: snapshot.messages[0].checkpoint.id, before: false });
  await native.forkStarted;
  releaseStop();
  assert.match((await removal).error.message, /fork to finish/);
  releaseFork();
  await copy;
  assert.deepEqual((await client.call("session.resume", { session_id: id })).messages, snapshot.messages);
});

test("a fork reserves its new identity while another connection adopts it", async (t) => {
  const native = agent();
  let release!: () => void;
  const forkId = randomUUID();
  native.holdResume(new Promise<void>((resolve) => { release = resolve; }), forkId);
  let adopted = 0;
  native.provider.adopt = async () => {
    adopted += 1;
    throw new Error("A second adoption must wait for the existing fork.");
  };
  const bridge = await startTestBridge({ providers: new Map([["fake", native.provider]]) });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  const other = await TestClient.open(bridge);
  t.after(async () => { await client.close(); await other.close(); });
  const id = await createThread(client);
  await client.call("session.set_mode", { session_id: id, mode: "ask" });
  await runTurn(client, id, "Open");
  const snapshot = await client.call("session.resume", { session_id: id });
  const copying = client.call("session.fork", { session_id: id, checkpoint_id: snapshot.messages[0].checkpoint.id, before: false });
  await native.resumeStarted;
  const adoption = other.call("session.adopt", { profile: "fake", session_id: forkId, mode: "continue" });
  // A later request's response proves the concurrent adoption reached the host.
  await other.call("gateway.ping");
  assert.equal(adopted, 0);
  release();
  assert.equal((await copying).session_id, forkId);
  assert.equal((await adoption).session_id, forkId);
  assert.equal(native.resumed.length, 1);
  assert.equal(native.resumed[0].mode, "ask");
  assert.equal(adopted, 0);
});
