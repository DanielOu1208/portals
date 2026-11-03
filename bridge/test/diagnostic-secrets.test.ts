import "./environment.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Connection } from "../src/gateway/connection.ts";
import type { GatewayContext } from "../src/gateway/methods.ts";
import { setLogLevel } from "../src/log.ts";
import { JsonChild, type ChildExit } from "../src/providers/child.ts";
import { processConnector } from "../src/providers/codex/client.ts";

const secret = "sk-ant-api03-" + "syntheticOnly".repeat(3);
const diagnostic = `ANTHROPIC_API_KEY=${secret}`;

function capture(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  setLogLevel("debug");
  t.after(() => setLogLevel("silent"));
  return lines;
}

test("a child's stderr is masked before logging and keeping its last words", async (t) => {
  const lines = capture(t);
  const gone = Promise.withResolvers<ChildExit>();
  const child = new JsonChild({
    name: "Synthetic",
    command: process.execPath,
    args: ["-e", 'process.stderr.write("ANTHROPIC_API_KEY=" + process.env.ANTHROPIC_API_KEY + "\\n")'],
    cwd: tmpdir(),
    env: { ANTHROPIC_API_KEY: secret },
    listener: { message() {}, exited: gone.resolve },
  });
  t.after(() => child.stop());
  const exit = await gone.promise;
  assert.equal(lines.join("").includes(secret), false);
  assert.equal(exit.lastWords?.includes(secret), false);
  assert.equal(exit.reason.includes(secret), false);
  assert.ok(exit.lastWords?.startsWith("ANTHROPIC_API_KEY="));
});

test("the owned Codex stand-in's stderr is masked before logging", async (t) => {
  const lines = capture(t);
  const directory = mkdtempSync(join(tmpdir(), "portals-diagnostic-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, "standin.mjs");
  writeFileSync(script, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(diagnostic + "\n")});\nsetTimeout(() => process.exit(0), 50);\n`, { mode: 0o700 });
  const gone = Promise.withResolvers<void>();
  const transport = await processConnector(script, {})({ message() {}, closed: () => gone.resolve() });
  t.after(() => transport.close());
  await gone.promise;
  await nextTurn();
  assert.ok(lines.join("").includes("codex app-server"));
  assert.equal(lines.join("").includes(secret), false);
});

test("an unexpected provider error is masked before logging and replying to a device", async (t) => {
  const lines = capture(t);
  const sent: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1, readyState: 1, bufferedAmount: 0,
    send: (text: string) => sent.push(text),
    close() {}, ping() {}, terminate() {},
  });
  const gateway = {
    machine: "test-machine",
    net: { revision: () => ({ id: "test-net", revision: 1 }) },
    fleet: { agent: () => ({ models: async () => { throw new Error(`Provider failed: ${diagnostic}`); } }) },
  } as unknown as GatewayContext;
  new Connection(socket, gateway, { replayEpoch: "test" }, { kind: "password" });
  socket.emit("message", Buffer.from(JSON.stringify({ id: "models", method: "model.options", params: {} })), false);
  await nextTurn();
  const answer = JSON.parse(sent.at(-1)!);
  assert.equal(answer.error.code, -32603);
  assert.equal(answer.error.message.includes(secret), false);
  assert.equal(lines.join("").includes(secret), false);
  assert.ok(answer.error.message.startsWith("Provider failed:"));
});
