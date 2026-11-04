import assert from "node:assert/strict";
import { test } from "node:test";
import permissions, { permissionCommand } from "../src/providers/pi/permission-extension.ts";

function gate(env: NodeJS.ProcessEnv = {}) {
  const handlers = new Map<string, any>();
  let command: (args: string) => Promise<void>;
  permissions({
    registerCommand(name, registered) {
      assert.equal(name, permissionCommand);
      command = registered.handler;
    },
    on(event: string, handler: any) { handlers.set(event, handler); },
  }, env);
  const questions: { title: string; choices: string[] }[] = [];
  return {
    questions,
    mode: (mode: string) => command!(mode),
    plan: () => handlers.get("before_agent_start")({ systemPrompt: "Original instructions." }),
    call: (toolName: string, choice: string | null = "Allow once", hasUI = true, nested = false) => handlers.get("tool_call")(
      { toolName, input: { command: "echo harmless", path: "note.txt" }, ...(nested ? { parentToolCallId: "script" } : {}) },
      { hasUI, ui: { select: async (title: string, choices: string[]) => { questions.push({ title, choices }); return choice ?? undefined; } } },
    ),
  };
}

test("default and full preserve Pi's behavior; ask gates bash, write and edit, including script calls", async () => {
  const pi = gate();
  for (const mode of ["default", "full", "ask"]) {
    await pi.mode(mode);
    for (const tool of ["bash", "write", "edit"]) {
      const before = pi.questions.length;
      assert.equal(await pi.call(tool), undefined);
      assert.equal(pi.questions.length - before, mode === "ask" ? 1 : 0);
    }
  }
  assert.deepEqual(pi.questions[0], { title: 'Allow bash?\n\n{"command":"echo harmless","path":"note.txt"}', choices: ["Allow once", "Deny"] });
  assert.equal((await pi.call("bash", "Deny", true, true)).block, true);
  assert.equal(await pi.call("read", "Deny"), undefined);
  assert.equal(await pi.plan(), undefined);
});

test("accept edits asks only for bash; missing UI, dismissal and unrecognised answers deny", async () => {
  const pi = gate();
  await pi.mode("edits");
  assert.equal(await pi.call("write", "Deny"), undefined);
  assert.equal(await pi.call("edit", "Deny"), undefined);
  for (const choice of ["Deny", null, "yes", "Allow for session"]) assert.equal((await pi.call("bash", choice)).block, true);
  const before = pi.questions.length;
  assert.equal((await pi.call("bash", "Allow once", false)).block, true);
  assert.equal(pi.questions.length, before);
  await assert.rejects(pi.mode("medium"), /Unknown Portals permission mode/);
  assert.equal((await pi.call("bash", "Deny")).block, true);
});

test("plan permits only the four read tools, blocks scripts and delegation, and can be left", async () => {
  const pi = gate();
  await pi.mode("plan");
  for (const tool of ["read", "grep", "find", "ls"]) assert.equal(await pi.call(tool), undefined);
  for (const tool of ["bash", "write", "edit", "codemode", "delegate_task", "mcp__write"]) assert.equal((await pi.call(tool)).block, true);
  assert.equal(pi.questions.length, 0);
  assert.match((await pi.plan()).systemPrompt, /^Original instructions\.[\s\S]*Plan mode/);
  await pi.mode("full");
  assert.equal(await pi.call("bash", "Deny"), undefined);
  assert.equal(await pi.plan(), undefined);
});

test("reloading the extension keeps the chosen mode inside its process", async () => {
  const env = {};
  for (const mode of ["ask", "edits", "plan", "full", "default"]) {
    await gate(env).mode(mode);
    const loaded = gate(env);
    const result = await loaded.call("bash", "Deny");
    assert.equal(result?.block === true, mode !== "full" && mode !== "default");
  }
});
