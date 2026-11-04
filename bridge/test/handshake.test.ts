import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { homedir, hostname, tmpdir } from "node:os";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { methods, type CallContext } from "../src/gateway/methods.ts";
import { machineWord } from "../src/platform.ts";
import { version } from "../src/version.ts";
import { createThread, mintTicket, RpcFailure, socketURL, startTestBridge, TestClient, type TestBridge } from "./helpers.ts";

// The handshake and the methods' answers and errors (docs/gateway-protocol.md,
// sections 3 to 5).

let bridge: TestBridge;
let client: TestClient;

before(async () => {
  bridge = await startTestBridge();
  client = await TestClient.open(bridge);
});

after(async () => {
  await client.close();
  await bridge.dispose();
});

async function failure(call: Promise<unknown>): Promise<RpcFailure> {
  try {
    await call;
  } catch (error) {
    if (error instanceof RpcFailure) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

test("gateway.ready comes first, with the epoch, heartbeat and the bridge block", async () => {
  const ticket = await mintTicket(bridge);
  const socket = new WebSocket(socketURL(bridge, `?ticket=${ticket}`));
  const first = JSON.parse(await new Promise<string>((resolve) => socket.once("message", (data) => resolve(data.toString()))));
  socket.close();
  assert.deepEqual(Object.keys(first.params), ["type", "payload"]);
  assert.equal(first.jsonrpc, "2.0");
  assert.equal(first.method, "event");
  assert.equal(first.params.type, "gateway.ready");
  assert.match(first.params.payload.replay_epoch, /^[0-9a-f]{32}$/);
  assert.equal(first.params.payload.heartbeat, true);
  assert.deepEqual(first.params.payload.bridge, { protocol: 1, version, features: ["turn_file_undo", "message_fork", "mcp_auth", "folders", "model_levels", "push_host", "desk_sessions", "model_names", "compaction", "rename", "activity", "model_default_levels", "question_details", "modes", "push_relay", "push_sealed", "push_muting", "folders_add", "machine", "fleet", "fleet_delta", "fleet_delta_positions", "fleet_pages", "thread_sync", "agent_kinds", "queue", "files", "agent_looks", "sidebar_order", "machine_order", "approval_notes", "thread_branch", "subagents", "turn_messages", "subagents_clear", "subagent_names", "subagent_calls", "status_headline", "poll_now", "resume_replay", "agent_threads", "recent_threads", "held_elsewhere", "turn_usage", "session_leave", "worktrees", "turn_diff", "file_read", "session_resync", "message_reconciliation", "push_watcher", "message_ids", "senders", "async_questions", "background_commands", "net", "net_rename", "net_rename_devices", "lean_deltas", "thread_search", "file_search", "file_mentions", "folder_search", "answer_owner", "bot_chat", "history_pages", "tell_starters", "update_notice", "model_levels_none", "git_status", "usage_read", "open_on_host", "steer_withdrawn", "disk_space"], machine: { hostname: hostname(), home: homedir(), id: first.params.payload.bridge.machine.id, os: process.platform === "darwin" ? "macos" : "linux" }, net: first.params.payload.bridge.net, disk: { free: 200e9, total: 500e9, level: "ok" } });
  const net = await client.call("net.list");
  assert.deepEqual(first.params.payload.bridge.net, { id: net.net, revision: net.revision });
  assert.match(first.params.payload.bridge.machine.id, /^[0-9a-f]{16}$/);
  assert.equal(first.params.payload.replay_epoch, bridge.replayEpoch);
});

test("the epoch is the same for every connection to one run, and new for the next run", async (t) => {
  const second = await TestClient.open(bridge);
  t.after(() => second.close());
  assert.equal(second.readyPayload.replay_epoch, client.readyPayload.replay_epoch);

  const other = await startTestBridge();
  t.after(() => other.dispose());
  assert.notEqual(other.replayEpoch, bridge.replayEpoch);
});

test("client.capabilities names the questions the bridge asks", async () => {
  assert.deepEqual(await client.call("client.capabilities", { server_requests: true }), { server_requests: ["approval", "clarify"] });
});

test("a connection's frames are taken in order, client.capabilities applied before the next is read, also one that came compressed with the next behind it as it was inflated", async (t) => {
  // What the app rests on when it sends its first calls behind client.capabilities
  // without waiting for its answer (docs/gateway-protocol.md, section 4).
  const ticket = await mintTicket(bridge);
  const written: Buffer[] = [];
  let raw: Socket | undefined;
  const socket = new WebSocket(socketURL(bridge, `?ticket=${ticket}`), {
    perMessageDeflate: true,
    createConnection: () => {
      const opened = connect({ host: "127.0.0.1", port: bridge.port });
      const write = opened.write.bind(opened) as (chunk: unknown, ...rest: unknown[]) => boolean;
      opened.write = ((chunk: unknown, ...rest: unknown[]) => {
        written.push(Buffer.from(chunk as Buffer));
        return write(chunk, ...rest);
      }) as typeof opened.write;
      raw = opened;
      return opened;
    },
  });
  t.after(() => socket.close());
  const frames: Record<string, any>[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await new Promise((resolve) => socket.once("open", resolve));
  const answered = (id: string) => frames.findIndex((frame) => frame.id === id && "result" in frame);
  // What the next call's handler sees of the connection.
  const seen: boolean[] = [];
  const handle = methods["gateway.ping"].handle;
  t.mock.method(methods["gateway.ping"], "handle", (params: Record<string, unknown>, context: CallContext) => {
    seen.push(context.caller.takesRequests);
    return handle(params, context);
  });

  // The two leave together, the first compressed and the second as it is, which the
  // bridge reads while it still inflates the first.
  raw!.cork();
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: "capabilities", method: "client.capabilities", params: { server_requests: true, padding: "x".repeat(20_000) } }));
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "gateway.ping", params: {} }), { compress: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  raw!.uncork();
  while (answered("ping") < 0) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(seen, [true]);
  assert.ok(answered("capabilities") >= 0 && answered("capabilities") < answered("ping"));
  const sent = Buffer.concat(written);
  assert.deepEqual(
    clientFrames(sent.subarray(sent.indexOf("\r\n\r\n") + 4)).map((frame) => frame.compressed),
    [true, false],
  );
});

/** The frames a client wrote, masked as a client's are: whether each was compressed (RSV1). Pings and the close are left out. */
function clientFrames(bytes: Buffer): { compressed: boolean }[] {
  const frames: { compressed: boolean }[] = [];
  for (let at = 0; at + 2 <= bytes.length; ) {
    let length = bytes[at + 1] & 0x7f;
    let header = 2;
    if (length === 126) {
      length = bytes.readUInt16BE(at + 2);
      header = 4;
    } else if (length === 127) {
      length = Number(bytes.readBigUInt64BE(at + 2));
      header = 10;
    }
    if (bytes[at + 1] & 0x80) header += 4;
    if ((bytes[at] & 0x0f) < 8) frames.push({ compressed: (bytes[at] & 0x40) !== 0 });
    at += header + length;
  }
  return frames;
}

test("gateway.ping is answered at once, under the app's own id", async () => {
  const response = await client.request("gateway.ping", {}, "heartbeat-1");
  assert.deepEqual(response, { jsonrpc: "2.0", id: "heartbeat-1", result: { ok: true } });
  // A numeric id is echoed as it came.
  assert.deepEqual((await client.request("gateway.ping", {}, 7)).result, { ok: true });
});

test("a frame that is not JSON is skipped and the connection stays up", async () => {
  client.send("this is not json");
  client.send("[1, 2]");
  assert.deepEqual(await client.call("gateway.ping"), { ok: true });
});

test("an unknown method is -32601 with a sentence", async () => {
  const error = await failure(client.call("sessions.delete", {}));
  assert.equal(error.code, -32601);
  assert.equal(error.message, "The bridge does not support sessions.delete.");
});

test("params the bridge does not read are ignored, not rejected", async () => {
  const result = await client.call("session.create", { profile: "fake", source: "tui", from_the_future: { x: 1 } });
  assert.match(result.session_id, /^[0-9a-f-]{36}$/);
});

test("a missing or mistyped param is -32602", async () => {
  assert.equal((await failure(client.call("session.resume", {}))).code, -32602);
  const mistyped = await failure(client.call("session.events.since", { session_id: "x", last_seen: "3" }));
  assert.equal(mistyped.code, -32602);
  assert.equal(mistyped.message, "last_seen must be a whole number.");
  const notObject = await client.request("profiles.list", [] as unknown as Record<string, unknown>);
  assert.equal(notObject.error.code, -32602);
});

test("profiles.list lists the fake agent", async () => {
  assert.deepEqual(await client.call("profiles.list"), {
    profiles: [
      {
        name: "fake",
        kind: "fake",
        display_name: "Fake agent",
        description: "A scripted agent for testing the bridge. It runs nothing and changes no files.",
        model: "fake-1",
        provider: "fake",
        is_default: true,
      },
    ],
  });
});

test("session.create answers with both ids and the session's info", async () => {
  const result = await client.call("session.create", { profile: "fake", source: "tui", title: "Probe", cwd: tmpdir(), model: "fake-2", provider: "fake", reasoning_effort: "high" });
  assert.equal(result.stored_session_id, result.session_id);
  assert.equal(result.info.title, "Probe");
  assert.equal(result.info.model, "fake-2");
  assert.equal(result.info.provider, "fake");
  assert.equal(result.info.reasoning_effort, "high");
  assert.equal(result.info.running, false);
  assert.equal(result.info.profile_name, "fake");

  // No title yet means none at all: the app would show "" as one.
  const untitled = await client.call("session.create", { profile: "fake" });
  assert.equal("title" in untitled.info, false);
});

test("session.create refuses what it cannot use, before the first turn", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ profile: "hermes" }, "There is no agent called hermes on this bridge."],
    [{ profile: "fake", cwd: "/no/such/folder" }, `The folder /no/such/folder does not exist on this ${machineWord()}.`],
    [{ profile: "fake", cwd: "/" }, "New threads can only start in General or a folder from the list, and / is not on it."],
    [{ profile: "fake", model: "gpt-0" }, "The Fake agent cannot run the model gpt-0."],
    [{ profile: "fake", provider: "openai" }, "The Fake agent has no provider called openai."],
    [{ profile: "fake", reasoning_effort: "extreme" }, "extreme is not a thinking level. Use one of: none, minimal, low, medium, high, xhigh, max, ultra."],
  ];
  for (const [params, message] of cases) {
    const error = await failure(client.call("session.create", params));
    assert.equal(error.code, -32602);
    assert.equal(error.message, message);
  }
});

test("an unknown thread is 4007, and events.since for one says truncated", async () => {
  const error = await failure(client.call("session.resume", { session_id: "nope", profile: "fake", inline_images: false }));
  assert.equal(error.code, 4007);
  assert.deepEqual(await client.call("session.events.since", { session_id: "nope", last_seen: 3 }), { events: [], truncated: true, latest_seq: 0, open_requests: [] });
});

test("calls on a session this connection does not follow are 4001, so the app resumes first", async (t) => {
  const session = await createThread(client);
  const other = await TestClient.open(bridge);
  t.after(() => other.close());
  for (const [method, params] of [
    ["prompt.submit", { session_id: session, text: "hi" }],
    ["session.interrupt", { session_id: session }],
    ["image.attach_bytes", { session_id: session, content_base64: "AAAA" }],
    ["slash.exec", { session_id: session, command: "status" }],
    ["config.set", { session_id: session, key: "reasoning", value: "low" }],
  ] as const) {
    assert.equal((await failure(other.call(method, params))).code, 4001, method);
  }
  // After resuming, the same call works.
  await other.call("session.resume", { session_id: session });
  assert.equal((await other.call("slash.exec", { session_id: session, command: "status" })).type, "exec");
});

test("model.options and config.get describe the agent's models and default level", async () => {
  assert.deepEqual(await client.call("model.options", { profile: "fake" }), {
    providers: [{ slug: "fake", name: "Fake", models: ["fake-1", "fake-2"], authenticated: true }],
    model: "fake-1",
    provider: "fake",
  });
  assert.deepEqual(await client.call("config.get", { key: "reasoning", profile: "fake" }), { value: "medium" });
  assert.equal((await failure(client.call("config.get", { key: "personality" }))).code, -32602);
});

test("config.set changes one thread's model and level, read the way the app writes them", async () => {
  const session = await createThread(client);
  assert.deepEqual(await client.call("config.set", { key: "model", value: "fake-2 --provider fake --session", session_id: session, profile: "fake" }), {});
  assert.deepEqual(await client.call("config.set", { key: "reasoning", value: "low", session_id: session, profile: "fake" }), {});
  const info = (await client.call("session.resume", { session_id: session })).info;
  assert.equal(info.model, "fake-2");
  assert.equal(info.reasoning_effort, "low");

  assert.equal((await failure(client.call("config.set", { key: "model", value: "nope --session", session_id: session }))).code, -32602);
  assert.equal((await failure(client.call("config.set", { key: "model", value: "fake-1 --global", session_id: session }))).code, -32602);
  assert.equal((await failure(client.call("config.set", { key: "reasoning", value: "lots", session_id: session }))).code, -32602);
  // Never the agent's default: without a session it is refused.
  assert.equal((await failure(client.call("config.set", { key: "model", value: "fake-2" }))).code, -32602);
});

test("commands: /status runs; anything else is 4018, then unknown to command.dispatch", async () => {
  const catalog = await client.call("commands.catalog", { profile: "fake" });
  assert.deepEqual(catalog.categories, [{ name: "Bridge", pairs: [["/status", "Show this thread's agent, folder, branch and model"]] }]);
  const session = await createThread(client);
  const status = await client.call("slash.exec", { session_id: session, command: "status", profile: "fake" });
  assert.equal(status.type, "exec");
  assert.match(status.output, /^Agent: fake\nFolder: .+\nModel: fake-1 from fake, thinking medium\nRunning: no\nThread: /);

  const refused = await failure(client.call("slash.exec", { session_id: session, command: "compact now" }));
  assert.equal(refused.code, 4018);
  const unknown = await failure(client.call("command.dispatch", { session_id: session, name: "compact", arg: "now" }));
  assert.equal(unknown.code, -32602);
  assert.equal(unknown.message, "There is no /compact command on this bridge.");
  assert.equal((await client.call("command.dispatch", { session_id: session, name: "status" })).type, "exec");
});

test("subagent.list is empty", async () => {
  assert.deepEqual(await client.call("subagent.list", { session_id: "anything", profile: "fake" }), { subagents: [] });
});
