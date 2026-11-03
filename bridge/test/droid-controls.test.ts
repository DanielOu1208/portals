import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DroidControls } from "../src/providers/droid/controls.ts";
import type { DroidHandle } from "../src/providers/droid/sdk.ts";

function rig() {
  const writes: unknown[] = [];
  const servers = [{ name: "test server", status: "connected", source: "user", isManaged: false, requiresAuth: true,
    pendingAuthUrl: "https://private.invalid/?state=SECRET", pendingAuthState: "SECRET", error: "private config" }];
  const handle = {
    listSkills: async () => ({ skills: [{ name: "test skill", enabled: true, location: "personal", description: "Safe description", content: "PRIVATE", filePath: "/private/skill" }] }),
    listMcpServers: async () => ({ servers }),
    listMcpTools: async () => [{ name: "test_tool", serverName: "test server", isEnabled: true, inputSchema: { secret: "PRIVATE" } }],
    setSkillDisabled: async (params: unknown) => { writes.push(params); return { success: true }; },
    toggleMcpServer: async (params: unknown) => { writes.push(params); return { success: true }; },
    toggleMcpTool: async (...params: unknown[]) => { writes.push(params); return { success: true }; },
  } as unknown as DroidHandle;
  return { handle, writes, servers, controls: new DroidControls() };
}

test("skills and MCP lists expose only display metadata, never content, paths, schemas or auth", async () => {
  const r = rig();
  for (const [kind, args] of [["skills", ""], ["mcp", ""], ["mcp", 'tools "test server"']] as const) {
    const text = await r.controls.run(kind, args, r.handle, 0);
    assert.doesNotMatch(text, /PRIVATE|SECRET|private\.invalid|private config|\/private/);
  }
  assert.deepEqual(r.writes, []);
});

for (const [kind, command, expected] of [
  ["skills", 'off "test skill"', { skillName: "test skill", disabled: true, settingsLevel: "user" }],
  ["mcp", 'off "test server"', { serverName: "test server", enabled: false, settingsLevel: "user" }],
  ["mcp", 'tool off "test server" test_tool', ["test server", "test_tool", false]],
] as const) {
  test(`${kind} ${command} needs an exact, unexpired second confirmation and reports the settings written`, async () => {
    const r = rig();
    const first = await r.controls.run(kind, `${command} confirm`, r.handle, 1);
    assert.match(first, /everywhere: every thread, the Droid CLI and the desktop app/);
    assert.deepEqual(r.writes, [], "even a first command carrying confirm writes nothing");
    const second = await r.controls.run(kind, `${command} confirm`, r.handle, 2);
    assert.match(second, /Droid's user settings/);
    assert.deepEqual(r.writes, [expected]);
    await r.controls.run(kind, `${command} confirm`, r.handle, 3);
    assert.equal(r.writes.length, 1, "confirmation is single-use");
    await r.controls.run(kind, `${command} confirm`, r.handle, 400_000);
    assert.equal(r.writes.length, 1, "expired confirmation writes nothing");
  });
}

test("a different action cannot reuse confirmation; project and managed MCP settings are never written", async () => {
  const r = rig();
  await r.controls.run("skills", 'off "test skill"', r.handle, 0);
  await r.controls.run("skills", 'on "test skill" confirm', r.handle, 1);
  assert.deepEqual(r.writes, []);
  for (const source of ["project", "org", "runtime"]) {
    r.servers[0].source = source;
    await assert.rejects(r.controls.run("mcp", 'off "test server"', r.handle, 0), /does not come from your user settings/);
    await assert.rejects(r.controls.run("mcp", 'tool off "test server" test_tool', r.handle, 0), /does not come from your user settings/);
  }
  r.servers[0].source = "user"; r.servers[0].isManaged = true;
  await assert.rejects(r.controls.run("mcp", 'off "test server"', r.handle, 0), /managed/);
  assert.deepEqual(r.writes, []);
});

test("malformed and unknown commands never write", async () => {
  const r = rig();
  for (const argument of ['off', 'tools a b', 'on nope', 'tool on "test server" missing', 'off "unterminated', 'off "test server" extra', 'off "\\u0000"']) {
    await assert.rejects(r.controls.run("mcp", argument, r.handle, 0));
  }
  assert.deepEqual(r.writes, []);
});

test("a skill, server or tool literally named confirm still uses two exact commands", async () => {
  for (const [kind, command] of [["skills", 'off "confirm"'], ["mcp", 'off "confirm"'], ["mcp", 'tool off "confirm" "confirm"']] as const) {
    const r = rig();
    r.handle.listSkills = async () => ({ skills: [{ name: "confirm" }] }) as never;
    r.servers[0].name = "confirm";
    r.handle.listMcpTools = async () => [{ name: "confirm", serverName: "confirm" }] as never;
    await r.controls.run(kind, command, r.handle, 0);
    assert.equal(r.writes.length, 0);
    await r.controls.run(kind, command + " confirm", r.handle, 1);
    assert.equal(r.writes.length, 1);
  }
});
