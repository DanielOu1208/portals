import assert from "node:assert/strict";
import { test } from "node:test";
import { methods } from "../src/gateway/methods.ts";
import { RpcError } from "../src/gateway/errors.ts";
import { startTestBridge, TestClient } from "./helpers.ts";

test("MCP auth list on a non-Droid thread is empty and mutations are unsupported", async (t) => {
  const bridge = await startTestBridge();
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const { session_id } = await client.call("session.create", { profile: "fake" });
  assert.deepEqual(await client.call("mcp.auth", { session_id, action: "list" }), { servers: [] });
  const response = await client.request("mcp.auth", { session_id, action: "start", server_name: "anything" });
  assert.equal(response.error.code, -32602);
  assert.equal(response.error.data, undefined);
});

test("read-only MCP auth mutations fail before reaching the provider", async () => {
  let called = false;
  const session = { isReadOnly: true, isFollowedBy: () => true, mcpAuth: () => { called = true; } };
  const context = { caller: {}, gateway: { sessions: { get: () => session } } } as unknown as Parameters<typeof methods["mcp.auth"]["handle"]>[1];
  for (const action of ["start", "submit", "cancel"]) {
    await assert.rejects(Promise.resolve().then(() => methods["mcp.auth"].handle({
      session_id: "readonly", action, server_name: "test", auth_id: "attempt", code: "PRIVATE",
    }, context)), (error: RpcError) => error.code === -32602 && error.data === undefined && !error.message.includes("PRIVATE"));
  }
  assert.equal(called, false);
});
