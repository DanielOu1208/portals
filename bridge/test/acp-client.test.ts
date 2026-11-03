import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setLogLevel } from "../src/log.ts";
import { AcpClient, AcpError, AgentStopped, refuse } from "../src/providers/acp/client.ts";
import type { RpcId } from "../src/providers/acp/protocol.ts";
import { temporaryHome } from "./helpers.ts";

// The bridge's end of the Agent Client Protocol, against the stand-in agent
// (test/acp-agent.ts) started as a child process, the way a real agent is: the hello,
// calls and their answers, what the agent sends by itself, and what is told when its
// process ends. How the process is started, read and ended is ../src/providers/child.ts
// (test/child.test.ts).

setLogLevel("silent");

const standin = fileURLToPath(new URL("./acp-agent.ts", import.meta.url));
const home = temporaryHome();
const clientInfo = { name: "portals-bridge", title: "Portals", version: "0.0.0" };
const started: AcpClient[] = [];
/** What a stand-in started, to end whatever a failed test left of it. */
const strays: number[] = [];

after(async () => {
  await Promise.all(started.map((client) => client.stop()));
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already, as it should be.
    }
  }
  rmSync(home, { recursive: true, force: true });
});

interface Told {
  method: string;
  params: any;
}

interface Run {
  client: AcpClient;
  /** Where the stand-in keeps every call it got (`calls.jsonl`). */
  directory: string;
  notifications: Told[];
  requests: (Told & { id: RpcId })[];
  stopped: string[];
}

interface RunOptions {
  features?: string;
  /** Another program in the stand-in's place. */
  command?: string;
  args?: string[];
  capabilities?: Record<string, unknown>;
  startTimeoutMs?: number;
  /** Answers a request from the agent; without it every request is refused. */
  answer?: (client: AcpClient, request: Told & { id: RpcId }) => void;
}

let runs = 0;

function run(options: RunOptions = {}): Run {
  const directory = join(home, `agent-${++runs}`);
  const notifications: Told[] = [];
  const requests: (Told & { id: RpcId })[] = [];
  const stopped: string[] = [];
  const client: AcpClient = new AcpClient({
    name: "Stand-in",
    command: options.command ?? process.execPath,
    args: options.args ?? [standin],
    env: { ...process.env, ACP_STANDIN_DIR: directory, ACP_STANDIN_FEATURES: options.features ?? "" },
    cwd: home,
    clientInfo,
    capabilities: options.capabilities,
    startTimeoutMs: options.startTimeoutMs,
    listener: {
      notification: (method, params) => notifications.push({ method, params }),
      request: (id, method, params) => {
        requests.push({ id, method, params });
        if (options.answer) options.answer(client, { id, method, params });
        else refuse(client, id, method);
      },
      stopped: (reason) => stopped.push(reason),
    },
  });
  started.push(client);
  return { client, directory, notifications, requests, stopped };
}

/** Every call and notification the stand-in got, in order. */
function calls(directory: string): { method: string; params: any }[] {
  const file = join(directory, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What a rejected promise was rejected with; null when it was not. */
function failure(promise: Promise<unknown>): Promise<Error | null> {
  return promise.then(
    () => null,
    (error: Error) => error,
  );
}

async function newSession(client: AcpClient): Promise<string> {
  return (await client.call("session/new", { cwd: home, mcpServers: [] })).sessionId;
}

function prompt(client: AcpClient, sessionId: string, text: string, timeoutMs = 0): Promise<{ stopReason: string }> {
  return client.call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, timeoutMs);
}

/** The reply as it streamed. */
function said(notifications: Told[]): string {
  return notifications.flatMap((told) => (told.method === "session/update" && told.params.update?.sessionUpdate === "agent_message_chunk" ? [told.params.update.content.text] : [])).join("");
}

test("hello: the agent is told the bridge's name and what the bridge can do, and says what it can do itself", async () => {
  const capabilities = { _meta: { parameterizedModelPicker: true } };
  const { client, directory, stopped } = run({ capabilities });
  assert.equal(client.isRunning, false);
  assert.equal(client.info, null);

  const info = await client.start();
  assert.equal(info.protocolVersion, 1);
  assert.equal(info.agentCapabilities?.loadSession, true);
  assert.equal(info.agentCapabilities?.promptCapabilities?.image, true);
  assert.deepEqual(info.agentInfo, { name: "standin", title: "Stand-in", version: "1.0.0" });
  assert.equal(client.info, info);
  assert.equal(client.isRunning, true);
  assert.ok(alive(client.pid!));

  // Asked to start again, it is the same process and the same hello.
  assert.equal(await client.start(), info);
  assert.deepEqual(
    calls(directory).map(({ method, params }) => ({ method, params })),
    [{ method: "initialize", params: { protocolVersion: 1, clientCapabilities: capabilities, clientInfo } }],
  );
  assert.deepEqual(stopped, []);

  // A bridge that says nothing of what it can do offers nothing.
  const plain = run();
  await plain.client.start();
  assert.deepEqual(calls(plain.directory)[0].params.clientCapabilities, {});
});

test("an agent that speaks another version of the protocol is refused, and its process ended", async () => {
  const { client, stopped } = run({ features: "version2" });
  const starting = failure(client.start());
  const pid = client.pid!;
  const error = await starting;
  assert.ok(error instanceof AgentStopped);
  assert.equal(error.message, "Stand-in speaks version 2 of the Agent Client Protocol; Portals speaks version 1.");
  assert.equal(client.isRunning, false);
  assert.equal(client.info, null);
  await client.stop();
  assert.equal(alive(pid), false);
  assert.equal(stopped.length, 1);
});

test("an agent that does not answer the hello in time is not started, and its process ended", async () => {
  // A program that runs and says nothing.
  const { client, stopped } = run({ command: process.execPath, args: ["-e", "setInterval(() => undefined, 1000);"], startTimeoutMs: 200 });
  const starting = failure(client.start());
  const pid = client.pid!;
  const error = await starting;
  assert.ok(error instanceof AgentStopped);
  assert.equal(error.message, "Stand-in did not start: Stand-in did not answer initialize within 0.2 seconds.");
  assert.equal(client.isRunning, false);
  await client.stop();
  assert.equal(alive(pid), false);
  assert.equal(stopped.length, 1);
});

test("a call is answered with its result, and an error comes with its code and what the agent added", async () => {
  const { client, directory } = run();
  await client.start();
  const made = await client.call("session/new", { cwd: home, mcpServers: [] });
  assert.match(made.sessionId, /^standin-/);
  assert.ok(Array.isArray(made.configOptions));

  const error = await failure(client.call("session/load", { sessionId: "nobody", cwd: home, mcpServers: [] }));
  assert.ok(error instanceof AcpError);
  assert.equal(error.code, -32002);
  assert.equal(error.message, "Resource not found");
  assert.equal(error.data, "no session nobody");
  // A call the agent has no method for is an error like any other, and the client goes on.
  const unknown = await failure(client.call("session/fly", {}));
  assert.ok(unknown instanceof AcpError);
  assert.equal(unknown.code, -32601);
  assert.equal(unknown.data, undefined);
  assert.match(await newSession(client), /^standin-/);

  assert.deepEqual(
    calls(directory).map((call) => call.method),
    ["initialize", "session/new", "session/load", "session/fly", "session/new"],
  );
  assert.equal(client.isRunning, true);
});

test("a notification reaches the agent: a turn is stopped by one", async () => {
  const { client, directory, notifications } = run();
  await client.start();
  const sessionId = await newSession(client);
  const turn = prompt(client, sessionId, "slow");
  await until(() => said(notifications) !== "");
  client.notify("session/cancel", { sessionId });
  assert.deepEqual(await turn, { stopReason: "cancelled" });
  const last = calls(directory).at(-1)!;
  assert.deepEqual([last.method, last.params], ["session/cancel", { sessionId }]);
});

test("a call the agent does not answer in time fails, and its late answer is passed over", async () => {
  const { client, notifications } = run();
  await client.start();
  const sessionId = await newSession(client);
  const error = await failure(prompt(client, sessionId, "slow", 100));
  assert.ok(error instanceof Error && !(error instanceof AgentStopped) && !(error instanceof AcpError));
  assert.equal(error.message, "Stand-in did not answer session/prompt within 0.1 seconds.");
  // The agent is still there, and still at it.
  assert.equal(client.isRunning, true);
  // The turn's last update, then its answer, which nobody waits for any more.
  await until(() => notifications.some((told) => told.params.update?.sessionUpdate === "usage_update"));
  // The next call gets its own answer, which the agent sends after that late one.
  assert.match(await newSession(client), /^standin-/);
  assert.deepEqual(await prompt(client, sessionId, "hello"), { stopReason: "end_turn" });
  assert.match(said(notifications), /pong: hello$/);
});

test("what the agent sends by itself reaches the listener: updates, a request that is answered, and one that is refused with -32601", async () => {
  const { client, notifications, requests } = run({
    answer: (client, request) => {
      if (request.method === "session/request_permission") client.respond(request.id, { outcome: { outcome: "selected", optionId: "once" } });
      else refuse(client, request.id, request.method);
    },
  });
  await client.start();
  const sessionId = await newSession(client);
  // A new session says its commands by itself, outside any call.
  await until(() => notifications.length === 1);
  assert.equal(notifications[0].method, "session/update");
  assert.equal(notifications[0].params.sessionId, sessionId);
  assert.equal(notifications[0].params.update.sessionUpdate, "available_commands_update");

  assert.deepEqual(await prompt(client, sessionId, "approve it, then use the editor"), { stopReason: "end_turn" });
  assert.deepEqual(
    requests.map((request) => [typeof request.id, request.method, request.params.sessionId]),
    [
      ["number", "session/request_permission", sessionId],
      ["number", "fs/write_text_file", sessionId],
    ],
  );
  assert.equal(requests[0].params.toolCall.toolCallId, "ask-1");
  assert.equal(requests[1].params.path, join(home, "x.txt"));
  // The agent got both answers: the choice, and the refusal's code.
  const ran = notifications.find((told) => told.params.update?.toolCallId === "ask-1" && told.params.update.status === "completed");
  assert.equal(ran?.params.update.content[0].content.text, "ran with once");
  assert.equal(said(notifications), "The command ran. The client answered -32601. pong: approve it, then use the editor");
});

test("when the agent's process ends, every waiting call fails with why, and the listener is told once", async () => {
  const { client, stopped, notifications } = run();
  await client.start();
  const one = await newSession(client);
  const two = await newSession(client);
  const slow = failure(prompt(client, one, "slow"));
  await until(() => said(notifications) !== "");
  const crashed = failure(prompt(client, two, "gasp, then crash"));
  const pid = client.pid!;

  const why = "Stand-in stopped (exit code 3): the stand-in fell over on purpose";
  for (const error of [await slow, await crashed]) {
    assert.ok(error instanceof AgentStopped);
    assert.equal(error.message, why);
  }
  assert.deepEqual(stopped, [why]);
  assert.equal(client.isRunning, false);
  assert.equal(alive(pid), false);

  // Nothing more is sent to it, and nothing more is told of it.
  const late = await failure(client.call("session/new", { cwd: home, mcpServers: [] }));
  assert.ok(late instanceof AgentStopped);
  assert.equal(late.message, "Stand-in is not running.");
  client.notify("session/cancel", { sessionId: one });
  await client.stop();
  assert.deepEqual(stopped, [why]);
});

test("a program that is not there fails the start, and the listener is told once", async () => {
  const { client, stopped } = run({ command: join(home, "no-such-agent"), args: ["acp"] });
  const error = await failure(client.start());
  assert.ok(error instanceof AgentStopped);
  assert.match(error.message, /^Stand-in could not be started \(.*ENOENT.*\)$/);
  assert.deepEqual(stopped, [error.message]);
  assert.equal(client.pid, undefined);
  assert.equal(client.isRunning, false);
  assert.equal(client.info, null);
  const late = await failure(client.call("session/new", {}));
  assert.ok(late instanceof AgentStopped);
  assert.equal(late.message, "Stand-in is not running.");
  await client.stop();
  assert.equal(stopped.length, 1);
});

test("lines of the agent's output that are no messages are passed over", async () => {
  // A banner, a number and a list before the hello's answer.
  const { client, stopped, notifications, requests } = run({ features: "noise" });
  const info = await client.start();
  assert.equal(info.protocolVersion, 1);
  const sessionId = await newSession(client);
  assert.deepEqual(await prompt(client, sessionId, "hello"), { stopReason: "end_turn" });
  assert.equal(said(notifications), "pong: hello");
  assert.deepEqual(requests, []);
  assert.deepEqual(stopped, []);
});

test("a stop ends the agent's process and what it started, and fails the call that was waiting", async () => {
  const { client, stopped, notifications } = run();
  await client.start();
  const sessionId = await newSession(client);
  await prompt(client, sessionId, "helper");
  const helper = Number(/^helper=(\d+)$/.exec(said(notifications))?.[1]);
  strays.push(helper);
  const pid = client.pid!;
  assert.ok(alive(pid));
  assert.ok(alive(helper));

  const waiting = failure(prompt(client, sessionId, "slow"));
  const stopping = client.stop();
  // It takes nothing more from the moment it is asked.
  assert.equal(client.isRunning, false);
  await stopping;
  assert.equal(alive(pid), false);
  assert.equal(alive(helper), false);
  const error = await waiting;
  assert.ok(error instanceof AgentStopped);
  // The stop is not told as a failure with the agent's last words: it was asked for.
  assert.equal(stopped.length, 1);
  assert.match(stopped[0], /^Stand-in stopped \((SIGTERM|exit code 0)\)$/);
  assert.equal(error.message, stopped[0]);
  // A second stop finds nothing to do.
  await client.stop();
  assert.equal(stopped.length, 1);
});
