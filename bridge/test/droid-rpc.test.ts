import "./environment.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DroidClient, DroidSession, FACTORY_PROTOCOL_VERSION, LEGACY_FACTORY_API_VERSION, ProcessTransport, SessionSettingsSchema } from "@factory/droid-sdk/node";
import { DroidTransport } from "../src/providers/droid/rpc.ts";

/** A JSON-RPC message as the SDK's transport carries it since 0.10.0: decoded, not a line of text. */
type Message = Parameters<ProcessTransport["send"]>[0];
function frame(fields: Record<string, unknown>): Message {
  return { jsonrpc: "2.0", factoryApiVersion: LEGACY_FACTORY_API_VERSION, factoryProtocolVersion: FACTORY_PROTOCOL_VERSION, ...fields } as Message;
}

test("Droid extra requests share the stream without stealing SDK responses or notifications", async (t) => {
  let receive!: (message: Message) => void;
  const original = ProcessTransport.prototype.onMessage;
  ProcessTransport.prototype.onMessage = function (handler) { receive = handler; };
  t.after(() => { ProcessTransport.prototype.onMessage = original; });
  class Transport extends DroidTransport {
    sent: Record<string, unknown>[] = [];
    override get isConnected() { return true; }
    override async send(message: Message) { this.sent.push(message as Record<string, unknown>); }
  }
  const transport = new Transport();
  t.after(() => transport.close());
  const sdk: Message[] = [];
  transport.onMessage((message) => sdk.push(message));
  const first = transport.request("droid.list_commands");
  const second = transport.request("droid.get_context_breakdown");
  const notification = frame({ type: "notification", method: "droid.session_notification", params: { notification: { type: "tool_progress_update" } } });
  receive(notification);
  receive(frame({ type: "response", id: "sdk-owned", result: {} }));
  receive(frame({ type: "response", id: transport.sent[1].id, result: { used: 10 } }));
  receive(frame({ type: "response", id: transport.sent[0].id, result: { commands: [] } }));
  assert.deepEqual(await first, { commands: [] });
  assert.deepEqual(await second, { used: 10 });
  assert.equal(sdk.length, 2);
  assert.equal(sdk[0], notification, "the SDK receives the untouched frame");
  assert.equal(transport.sent[0].jsonrpc, "2.0");
  assert.match(String(transport.sent[0].id), /^portals-/);
  const failed = transport.request("droid.list_commands");
  receive(frame({ type: "response", id: transport.sent[2].id, error: { code: -32603, message: "Not available" } }));
  await assert.rejects(failed, /Not available/);
  const custom = transport.request("droid.add_user_message", {}, "portals-queued-message");
  const notOwned = frame({ type: "response", id: "portals-not-owned", result: "pass through" });
  receive(notOwned);
  receive(frame({ type: "response", id: "portals-queued-message", result: { queued: true } }));
  assert.deepEqual(await custom, { queued: true });
  assert.equal(sdk.at(-1), notOwned);
});

test("Droid extra request rejects when sending fails", async () => {
  class Transport extends DroidTransport {
    override get isConnected() { return true; }
    override async send() { throw new Error("Send failed"); }
  }
  await assert.rejects(new Transport().request("droid.list_commands"), /Send failed/);
});

test("Droid's list of background processes, which the SDK drops, is told with its session; the SDK still gets the frame", async (t) => {
  let receive!: (message: Message) => void;
  const original = ProcessTransport.prototype.onMessage;
  ProcessTransport.prototype.onMessage = function (handler) { receive = handler; };
  t.after(() => { ProcessTransport.prototype.onMessage = original; });
  class Transport extends DroidTransport { override get isConnected() { return true; } }
  const transport = new Transport();
  t.after(() => transport.close());
  const sdk: Message[] = [];
  transport.onMessage((message) => sdk.push(message));
  const lists: [string, unknown][] = [];
  const processes = [{ id: "toolu_1", pid: 73152, command: "sleep 12; echo done", startedAtMs: 1793763090554, toolUseId: "toolu_1" }];
  const changed = (sessionId: unknown, list: unknown) => frame({ type: "notification", method: "droid.session_notification",
    params: { ...(sessionId === undefined ? {} : { sessionId }), notification: { type: "background_processes_changed", processes: list } } });
  receive(changed("session", processes));
  transport.backgroundProcesses = (session, list) => lists.push([session, list]);
  receive(changed("session", processes));
  receive(changed(undefined, processes));
  receive(frame({ type: "notification", method: "droid.session_notification", params: { sessionId: "session", notification: { type: "tool_progress_update", processes } } }));
  receive(changed("session", []));
  assert.deepEqual(lists, [["session", processes], ["session", []]]);
  assert.equal(sdk.length, 5);
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "timed out waiting for the condition");
}

/** A DroidTransport whose process is a script: what the SDK sends is kept, and `receive` gives it Droid's frames, decoded as the SDK's transport gives them. */
function scripted(t: { after(fn: () => void): void }, answer?: (frame: Record<string, unknown>) => unknown) {
  let receive!: (message: Message) => void;
  const sent: Record<string, unknown>[] = [];
  const { onMessage, send } = ProcessTransport.prototype;
  ProcessTransport.prototype.onMessage = function (handler) { receive = handler; };
  ProcessTransport.prototype.send = async function (message: Message) {
    const sentFrame = message as Record<string, unknown>;
    sent.push(sentFrame);
    const result = answer?.(sentFrame);
    if (result !== undefined) queueMicrotask(() => receive(frame({ type: "response", id: sentFrame.id, result })));
  };
  t.after(() => { Object.assign(ProcessTransport.prototype, { onMessage, send }); });
  class Transport extends DroidTransport { override get isConnected() { return true; } }
  const transport = new Transport();
  const notify = (sessionId: string, notification: Record<string, unknown>) =>
    receive(frame({ type: "notification", method: "droid.session_notification", params: { sessionId, notification } }));
  return { transport, sent, notify, receive: (message: Message) => receive(message) };
}

test("a message Droid took into a turn it was running ends with that turn, though Droid names only the turn's id (2026-10-27)", async (t) => {
  const { transport, sent, notify } = scripted(t, (frame) => frame.method === "droid.load_session"
    ? { session: { messages: [] }, settings: { modelId: "small", reasoningEffort: "low" } } : {});
  const client = new DroidClient({ transport });
  await client.loadSession({ sessionId: "thread-session" });
  const session = new DroidSession(client, "thread-session", { settings: SessionSettingsSchema.parse({ modelId: "small", reasoningEffort: "low" }), cwd: "/tmp" }, { loadParams: {} });
  const events: string[] = [];
  const done = (async () => {
    for await (const event of session.stream("continue", { includePartialMessages: true })) events.push(event.type);
  })();
  await until(() => sent.some((frame) => frame.method === "droid.add_user_message"));
  const messageId = (sent.find((frame) => frame.method === "droid.add_user_message")!.params as { messageId: string }).messageId;
  // Droid is at work on a turn it began by itself (a background Script's completion): the message joins it.
  notify("thread-session", { type: "create_message", message: { id: messageId, role: "user", content: [{ type: "text", text: "continue" }], createdAt: 1, updatedAt: 1 } });
  notify("thread-session", { type: "create_message", message: { id: "reply", role: "assistant", content: [{ type: "text", text: "Done." }], createdAt: 2, updatedAt: 2 } });
  const tokenUsage = { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 3, thinkingTokens: 0 };
  notify("thread-session", { type: "agent_turn_completed", reason: "completed", turnId: "script-completion:thread-session:toolu_1:toolu_1", tokenUsage, durationMs: 5 });
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("the message's stream never ended")), 2000))]);
  assert.ok(events.includes("result"), `the stream ends with a result: ${events.join(", ")}`);
  await session.close().catch(() => undefined);
});

test("only a message Droid took, in its own session, ends with another turn's end; a steering message of ours and a turn's own end add none", async (t) => {
  const { transport, sent, notify, receive } = scripted(t, (frame) => frame.method === "droid.add_user_message" ? {} : undefined);
  const delivered: Record<string, unknown>[] = [];
  transport.onMessage((message) => delivered.push(message as Record<string, unknown>));
  const ends = () => delivered.filter((frame) => (frame.params as { notification?: { type?: string } })?.notification?.type === "agent_turn_completed")
    .map((frame) => (frame.params as { notification: { turnId: string } }).notification.turnId);
  const add = (id: string, messageId: string) => transport.send(frame({ type: "request", id, method: "droid.add_user_message", params: { messageId, text: "hi" } }));
  const made = (session: string, id: string) => notify(session, { type: "create_message", message: { id, role: "user", content: [] } });
  const end = (session: string, turnId: string) => notify(session, { type: "agent_turn_completed", reason: "completed", turnId, tokenUsage: {} });
  // Ours: a steering message no stream waits for.
  void transport.request("droid.add_user_message", { messageId: "steer", text: "steer" }, "portals-steer").catch(() => undefined);
  receive(frame({ type: "response", id: "portals-steer", result: {} }));
  made("main", "steer");
  await add("sdk-1", "own");
  made("main", "own");
  end("main", "own");
  await add("sdk-2", "untaken");
  await add("sdk-3", "taken");
  made("main", "taken");
  await add("sdk-4", "elsewhere");
  made("child", "elsewhere");
  end("main", "task-completion:one");
  assert.deepEqual(ends(), ["own", "task-completion:one", "taken"]);
  end("child", "child-turn");
  assert.deepEqual(ends().slice(3), ["child-turn", "elsewhere"]);
  assert.equal(sent.length, 5);
});

test("a user-only refusal ends only the SDK stream whose request Droid refused, not the background turn (D6)", async (t) => {
  const { transport, notify } = scripted(t);
  const delivered: Record<string, unknown>[] = [];
  transport.onMessage((message) => delivered.push(message as Record<string, unknown>));
  await transport.send(frame({ type: "request", id: "sdk-request", method: "droid.add_user_message", params: { messageId: "sdk-message", text: "large" } }));
  const refused = (requestId: string, role = "system", visibility = "user_only") => notify("main", {
    type: "create_message", requestId, message: {
      id: `refusal-${requestId}`, role, visibility, content: [{ type: "text", text: "Error: Your message is too large. The message was not sent." }],
    },
  });
  refused("another-request");
  refused("sdk-request", "assistant");
  refused("sdk-request", "system", "llm_only");
  assert.equal(delivered.length, 3);
  refused("sdk-request");
  assert.equal(delivered.length, 5);
  assert.deepEqual((delivered.at(-1)?.params as { notification: unknown }).notification, {
    type: "agent_turn_completed", turnId: "sdk-message", reason: "error",
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 },
  });
  refused("sdk-request");
  assert.equal(delivered.length, 6, "a duplicate refusal creates no second end");
  notify("main", { type: "agent_turn_completed", turnId: "execute-completion:background", reason: "completed", tokenUsage: {} });
  assert.equal(delivered.length, 7, "the background turn still ends only with its own completion");
});

test("Droid 1.0's recorded oversized refusal settles the actual SDK iterator with the model-window reason (R4, D6)", async (t) => {
  const { transport, sent, receive } = scripted(t, (request) => request.method === "droid.load_session"
    ? { session: { messages: [] }, settings: { modelId: "small", reasoningEffort: "low" } } : {});
  const client = new DroidClient({ transport });
  await client.loadSession({ sessionId: "thread-session" });
  const session = new DroidSession(client, "thread-session", {
    settings: SessionSettingsSchema.parse({ modelId: "small", reasoningEffort: "low" }), cwd: "/tmp",
  }, { loadParams: {} });
  t.after(() => session.close());
  const results: { success: boolean; error: { message: string } | null }[] = [];
  let finished = false;
  const done = (async () => {
    for await (const event of transport.stream(session, "a large generated prompt", { includePartialMessages: true })) {
      if (event.type === "result") results.push(event);
    }
    finished = true;
  })();
  await until(() => sent.some((frame) => frame.method === "droid.add_user_message"));
  const request = sent.find((frame) => frame.method === "droid.add_user_message")!;
  const rows = readFileSync(new URL("./fixtures/droid/oversized-background.jsonl", import.meta.url), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { kind: string; generated?: string; notification?: Message });
  const start = rows.findIndex((row) => row.kind === "send" && row.generated);
  assert.ok(start > 0);
  for (const row of rows.slice(start + 1)) {
    if (row.kind !== "notification" || !row.notification) continue;
    const notification = (row.notification as { params: { notification: Record<string, unknown> } }).params.notification;
    const made = notification.message as { role?: string; visibility?: string } | undefined;
    if (made?.role === "system" && made.visibility === "user_only") notification.requestId = request.id;
    receive(row.notification);
  }
  await until(() => finished);
  await done;
  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.match((results[0].error as { message: string }).message, /at most 872,000 tokens.*message was not sent/);
  assert.equal(transport.refusedEnd({ type: "agent_turn_completed", turnId: (request.params as { messageId: string }).messageId }), true);
  assert.equal(transport.refusedEnd({ type: "agent_turn_completed", turnId: "execute-completion:background" }), false);
  // The refused iterator released the SDK's slot; a fresh stream works on the same process.
  finished = false;
  const next = (async () => {
    for await (const _ of transport.stream(session, "short enough", { includePartialMessages: true })) {}
    finished = true;
  })();
  await until(() => sent.filter((frame) => frame.method === "droid.add_user_message").length === 2);
  const last = sent.findLast((frame) => frame.method === "droid.add_user_message")!;
  receive(frame({ type: "notification", method: "droid.session_notification", params: { notification: {
    type: "agent_turn_completed", turnId: (last.params as { messageId: string }).messageId, reason: "completed",
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 },
  } } }));
  await until(() => finished);
  await next;
});

test("the last call Droid said a session it loaded took is kept for the meter", async (t) => {
  const usage = { inputTokens: 908, outputTokens: 1004, cacheReadTokens: 137_309 };
  const { transport } = scripted(t, (frame) => frame.method === "droid.load_session" ? { lastCallTokenUsage: usage } : undefined);
  transport.onMessage(() => undefined);
  assert.equal(transport.loadedUsage, undefined);
  await transport.send(frame({ type: "request", id: "load-1", method: "droid.load_session", params: { sessionId: "s" } }));
  await until(() => transport.loadedUsage !== undefined);
  assert.deepEqual(transport.loadedUsage, usage);
});

test("Droid's pick list (droid.pick_options) is answered by the bridge's handler, and the SDK's client, which would cancel it, never sees it (n14, SDK 0.10.0)", async (t) => {
  const { transport, sent, receive } = scripted(t);
  const delivered: Record<string, unknown>[] = [];
  transport.onMessage((message) => delivered.push(message as Record<string, unknown>));
  const asked: unknown[] = [];
  transport.pickOptions = async (params) => { asked.push(params); return { selectedIds: ["C2"] }; };
  const params = { toolCallId: "pick-1", title: "Channels", rows: [{ id: "C1", label: "general" }, { id: "C2", label: "dev" }], multi: false, preselectedIds: [] };
  receive(frame({ type: "request", id: "pick-request", method: "droid.pick_options", params }));
  await until(() => sent.length === 1);
  assert.deepEqual(asked, [params]);
  assert.equal(delivered.length, 0);
  assert.deepEqual({ ...sent[0], factoryProtocolVersion: undefined }, { jsonrpc: "2.0", type: "response", factoryApiVersion: LEGACY_FACTORY_API_VERSION, factoryProtocolVersion: undefined, id: "pick-request", result: { selectedIds: ["C2"] } });
  // A handler that fails cancels it.
  transport.pickOptions = async () => { throw new Error("no card"); };
  receive(frame({ type: "request", id: "pick-2", method: "droid.pick_options", params }));
  await until(() => sent.length === 2);
  assert.deepEqual(sent[1].result, { cancelled: true, selectedIds: [] });
});

test("initialize and load always install the bridge callback, suppressing host-browser opening on fresh and resumed processes", async (t) => {
  const { transport, sent, notify, receive } = scripted(t);
  t.after(() => transport.close());
  transport.onMessage(() => undefined);
  for (const method of ["droid.initialize_session", "droid.load_session"]) {
    await transport.send(frame({ type: "request", id: method, method, params: { sessionId: "session", mcpOAuthCallbackUri: "old" } }));
    const params = sent.at(-1)!.params as { sessionId: string; mcpOAuthCallbackUri: string };
    assert.equal(params.sessionId, "session");
    assert.match(params.mcpOAuthCallbackUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  }
  const uri = (sent[0].params as { mcpOAuthCallbackUri: string }).mcpOAuthCallbackUri;
  const complete = `${uri}?state=public-state&code=secret-code`;
  const required = () => notify("session", { type: "mcp_auth_required", serverName: "server", state: "secret-state", authUrl: "https://auth.invalid/authorize?state=public-state" });
  required();
  assert.equal((await fetch(complete)).status, 404, "no live start, even if a notification supplies a state");
  await transport.send(frame({ type: "request", method: "droid.authenticate_mcp_server", id: "auth", params: { serverName: "server" } }));
  required();
  const callback = fetch(complete);
  await until(() => sent.some((frame) => frame.method === "droid.submit_mcp_auth_code"));
  const submitted = sent.find((frame) => frame.method === "droid.submit_mcp_auth_code")!;
  assert.deepEqual(submitted.params, { serverName: "server", state: "secret-state", code: "secret-code" });
  receive(frame({ type: "response", id: submitted.id, result: { success: true } }));
  assert.equal((await callback).status, 200);
  required();
  await transport.send(frame({ type: "request", method: "droid.cancel_mcp_auth", id: "cancel", params: { serverName: "server" } }));
  required();
  assert.equal((await fetch(complete)).status, 404, "a late notification cannot rearm a cancelled start");
});

test("raw authentication requests can outlive the SDK's five-minute timeout", async (t) => {
  const { transport } = scripted(t);
  transport.onMessage(() => undefined);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ended = false;
  const request = transport.request("droid.authenticate_mcp_server", { serverName: "server" }, undefined, 630_000)
    .catch(() => { ended = true; });
  t.mock.timers.tick(5 * 60_000 + 1); await Promise.resolve();
  assert.equal(ended, false);
  t.mock.timers.tick(330_000); await request;
  assert.equal(ended, true);
});

test("an Error: note Droid writes for a message it already took makes no refused end, so the turn's real end still comes (PR #19 review R1)", async (t) => {
  const { transport, notify } = scripted(t);
  const delivered: Record<string, unknown>[] = [];
  transport.onMessage((message) => delivered.push(message as Record<string, unknown>));
  const ends = () => delivered.filter((frame) => (frame.params as { notification?: { type?: string } })?.notification?.type === "agent_turn_completed");
  await transport.send(frame({ type: "request", id: "sdk-request", method: "droid.add_user_message", params: { messageId: "sdk-message", text: "hi" } }));
  // Droid took the message: its user row was made.
  notify("main", { type: "create_message", message: { id: "sdk-message", role: "user", content: [] } });
  // A note in the middle of the turn, tied to the same request (an API error Droid retries).
  notify("main", { type: "create_message", requestId: "sdk-request", message: {
    id: "note", role: "system", visibility: "user_only", content: [{ type: "text", text: "Error: upstream overloaded, retrying" }],
  } });
  assert.equal(ends().length, 0);
  assert.equal(transport.refusedEnd({ type: "agent_turn_completed", turnId: "sdk-message" }), false);
  notify("main", { type: "agent_turn_completed", turnId: "sdk-message", reason: "completed", tokenUsage: {} });
  assert.equal(ends().length, 1);
});

/** A real SDK session on a scripted transport, and one message's stream on it: what it yielded, and the message's id once sent. */
async function streamed(t: { after(fn: () => void): void }) {
  const script = scripted(t, (frame) => frame.method === "droid.load_session"
    ? { session: { messages: [] }, settings: { modelId: "small", reasoningEffort: "low" } } : {});
  const client = new DroidClient({ transport: script.transport });
  await client.loadSession({ sessionId: "thread-session" });
  const session = new DroidSession(client, "thread-session", { settings: SessionSettingsSchema.parse({ modelId: "small", reasoningEffort: "low" }), cwd: "/tmp" }, { loadParams: {} });
  t.after(() => { void session.close().catch(() => undefined); });
  const results: { success: boolean; error: { message: string } | null }[] = [];
  let finished = false;
  void (async () => {
    for await (const event of script.transport.stream(session, "hello", { includePartialMessages: true })) {
      if (event.type === "result") results.push(event);
    }
    finished = true;
  })();
  await until(() => script.sent.some((frame) => frame.method === "droid.add_user_message"));
  const messageId = (script.sent.find((frame) => frame.method === "droid.add_user_message")!.params as { messageId: string }).messageId;
  // Droid took the message: its user row was made, and it is at work.
  script.notify("thread-session", { type: "droid_working_state_changed", newState: "streaming_assistant_message" });
  script.notify("thread-session", { type: "create_message", message: { id: messageId, role: "user", content: [{ type: "text", text: "hello" }], createdAt: 1, updatedAt: 1 } });
  return { ...script, messageId, results, finished: () => finished };
}

const usage = { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 3, thinkingTokens: 0 };

test("a turn's end the SDK cannot read as Droid sent it (a reason it does not know, usage counts left out) still ends the turn, the unknown reason as a failure that names it", async (t) => {
  for (const [end, success] of [
    [{ reason: "some_future_reason", tokenUsage: usage }, false],
    [{ reason: "completed", tokenUsage: { inputTokens: 1 } }, true],
    [{ reason: "completed", tokenUsage: usage, cumulativeTokenUsage: { inputTokens: 4, outputTokens: 2 } }, true],
  ] as const) {
    const run = await streamed(t);
    run.notify("thread-session", { type: "agent_turn_completed", turnId: run.messageId, ...end });
    run.notify("thread-session", { type: "droid_working_state_changed", newState: "idle" });
    await until(run.finished);
    assert.equal(run.results.length, 1, JSON.stringify(end));
    assert.equal(run.results[0].success, success);
    if (!success) assert.equal(run.results[0].error?.message, `Droid ended the turn with a reason Portals does not know ("some_future_reason").`);
    await run.transport.close();
  }
});

test("a turn's end the SDK can read is passed on as Droid sent it", async (t) => {
  const { transport, notify } = scripted(t);
  const delivered: Record<string, unknown>[] = [];
  transport.onMessage((message) => delivered.push(message as Record<string, unknown>));
  notify("main", { type: "agent_turn_completed", turnId: "turn", reason: "completed", tokenUsage: usage, durationMs: 5 });
  assert.deepEqual((delivered[0].params as { notification: unknown }).notification, { type: "agent_turn_completed", turnId: "turn", reason: "completed", tokenUsage: usage, durationMs: 5 });
});

test("Droid idle with a message's turn not ended, its end lost, ends that turn as failed once Droid stays idle; at work again in time, it does not", async (t) => {
  const run = await streamed(t);
  run.transport.idleEndMs = 30;
  // Idle, then at work again before the time is up: the turn goes on, and ends with its own end.
  run.notify("thread-session", { type: "droid_working_state_changed", newState: "idle" });
  run.notify("thread-session", { type: "droid_working_state_changed", newState: "thinking" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(run.finished(), false);
  // Its end, which the SDK cannot read in any way, then idle: Droid's word for the turn is lost.
  run.notify("thread-session", { type: "agent_turn_completed", turnId: 42, reason: "completed", tokenUsage: usage });
  // A process's idle as it starts names no session, and another session's is not this turn's.
  run.notify("", { type: "droid_working_state_changed", newState: "idle" });
  run.notify("child", { type: "droid_working_state_changed", newState: "idle" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(run.finished(), false);
  run.notify("thread-session", { type: "droid_working_state_changed", newState: "idle" });
  // Nor is another session at work.
  run.notify("child", { type: "droid_working_state_changed", newState: "thinking" });
  await until(run.finished);
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].success, false);
  assert.match(run.results[0].error?.message ?? "", /stopped working without saying the turn had ended/);
  assert.equal(run.transport.refusedEnd({ type: "agent_turn_completed", turnId: run.messageId }), true, "the made end reaches no provider's own turn");
  await run.transport.close();
});
