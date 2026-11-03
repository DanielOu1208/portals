import "./environment.ts";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { dispatch, exec } from "../src/gateway/commands.ts";
import type { AgentCommand, Provider } from "../src/providers/types.ts";
import type { Session } from "../src/sessions/session.ts";

const session = { id: "thread", record: { cwd: "/tmp" } } as unknown as Session;

function agent(list: Promise<AgentCommand[]>, executes?: readonly string[]): Provider {
  return { profile: { name: "agent", displayName: "Agent" }, executes, commands: () => list } as unknown as Provider;
}

/** What `slash.exec` answers within a moment: its error's code, its output, or "waiting". */
async function answer(provider: Provider, line: string): Promise<unknown> {
  const answered = exec(session, provider, line).then((result) => result.output, (error: { code?: number }) => error.code);
  return Promise.race([answered, sleep(200).then(() => "waiting")]);
}

test("slash.exec answers 4018 for a command the bridge does not run without waiting for the agent's list, which may still be loading", async () => {
  const loading = new Promise<AgentCommand[]>(() => undefined);
  assert.equal(await answer(agent(loading), "/compact keep it short"), 4018);
  assert.equal(await answer(agent(loading, ["cost"]), "/compact"), 4018);
  // One the bridge runs for the agent is still looked up, and run.
  const listed = Promise.resolve([{ name: "cost", description: "Cost", usage: "", skill: false, execute: async (argument: string) => `spent ${argument}` }]);
  assert.equal(await answer(agent(listed, ["cost"]), "/cost now"), "spent now");
  // Named as one, but the list has no such command to run: 4018 as before.
  assert.equal(await answer(agent(Promise.resolve([]), ["cost"]), "/cost"), 4018);
});

test("Droid-wide controls refuse read-only threads through both command RPCs", async () => {
  let writes = 0;
  const readOnly = { ...session, isReadOnly: true } as unknown as Session;
  const provider = agent(Promise.resolve(["skills", "mcp"].map((name) => ({
    name, description: name, usage: "", skill: false, requiresWritable: true,
    execute: async () => { writes++; return "changed"; },
  }))), ["skills", "mcp"]);
  for (const name of ["skills", "mcp"]) {
    await assert.rejects(exec(readOnly, provider, `/${name} off test confirm`), { code: -32602 });
    await assert.rejects(dispatch(readOnly, provider, name, "off test confirm"), { code: -32602 });
  }
  assert.equal(writes, 0);
  assert.equal((await exec(session, provider, "/skills off test confirm")).output, "changed");
});

test("slash.exec preserves whitespace inside quoted control names, including the confirming command", async () => {
  const provider = agent(Promise.resolve(["skills", "mcp"].map((name) => ({
    name, description: name, usage: "", skill: false, requiresWritable: true,
    execute: async (argument: string) => argument,
  }))), ["skills", "mcp"]);
  for (const [name, argument] of [["skills", 'off "test  skill"'], ["mcp", 'off "test  server"'], ["mcp", 'tool off "test  server" "test  tool"']]) {
    for (const suffix of ["", " confirm"]) {
      assert.equal((await exec(session, provider, ` /${name}\t${argument}${suffix} `)).output, argument + suffix);
      assert.equal((await dispatch(session, provider, name, argument + suffix)).output, argument + suffix);
    }
  }
});
