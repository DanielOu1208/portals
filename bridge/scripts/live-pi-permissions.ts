import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProvider } from "../src/providers/pi/provider.ts";

// Six harmless model turns through a scratch host and the app's RPC client, using
// Pi's existing ChatGPT sign-in. No copied credentials or settings changes. All
// sessions and files stay under LIVE_ROOT. Run without test/environment.ts:
//
//   LIVE_ROOT=/tmp/pi-permissions node scripts/live-pi-permissions.ts
//
// PI_LIVE_PI can name another installed executable; PI_LIVE_MODEL defaults to
// openai/gpt-6-luna. PI_LIVE_CASE=nested runs only the first turn. Only the
// permission and built-in codemode extensions load; MCP and project instructions do not.

const original = { ...process.env };
const root = original.LIVE_ROOT ?? join(tmpdir(), "pi-permissions");
mkdirSync(root, { recursive: true });
const run = realpathSync(mkdtempSync(join(root, "run-")));
const work = join(run, "work");
mkdirSync(work);
writeFileSync(join(work, "read.txt"), "quince\n");
const pi = original.PI_LIVE_PI ?? execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const version = execFileSync(pi, ["--version"], { encoding: "utf8", env: original }).trim();
const nestedOnly = original.PI_LIVE_CASE === "nested";
const model = original.PI_LIVE_MODEL ?? "openai/gpt-6-luna";
assert.ok(model.startsWith("openai/"), "Use a small OpenAI model on the existing ChatGPT sign-in");
const wrapper = join(run, "pi-live");
writeFileSync(wrapper, '#!/bin/sh\nprintf \'%s\\n\' "$$" >> "$PI_LIVE_PIDS"\nexec "$PI_LIVE_EXECUTABLE" --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp --offline -e builtin:codemode --tools +codemode "$@"\n', { mode: 0o755 });
const env: NodeJS.ProcessEnv = {
  ...original,
  PI_LIVE_EXECUTABLE: pi,
  PI_LIVE_PIDS: join(run, "pids"),
  PI_CODING_AGENT_DIR: original.PI_CODING_AGENT_DIR ?? join(original.HOME!, ".pi", "agent"),
  PI_CODING_AGENT_SESSION_DIR: join(run, "sessions"),
};
delete env.PORTALS_THREAD;

// The test helper isolates HOME when imported. Restore the original environment
// before starting any real Pi, and give the host only this run's scratch folder.
const { isEvent, startTestBridge, TestClient } = await import("../test/helpers.ts");
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, original, { TMPDIR: run });
delete process.env.PORTALS_THREAD;
const provider = new PiProvider({ settings: { path: wrapper, folder: work, model, titleModel: null, idleMinutes: 15, maxWarm: 1 }, env, terminals: async () => ({ folders: [], unread: [] }) });
const bridge = await startTestBridge({ providers: new Map([["pi", provider]]), userHome: work, temporaryFolders: [], config: { generalFolder: work } });
const client = await TestClient.open(bridge);
const long = 120_000;
let ids = 0;
client.call = async (method, params = {}) => {
  const id = `live${ids++}`;
  client.send({ jsonrpc: "2.0", id, method, params });
  const reply = await client.find((frame) => frame.id === id && !frame.method && ("result" in frame || "error" in frame), long);
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
};
let turns = 0;
let cards = 0;
let answer = "Deny";
let stop = false;
let session = "";
const answering = (async () => {
  while (true) {
    const card = await client.nextRequest(long);
    cards += 1;
    assert.equal(card.method, "clarify");
    const question = card.params.questions[0];
    console.log(`CARD ${question.question}`);
    if (stop) await client.call("session.interrupt", { session_id: session });
    else client.answer(card.id, { answers: { [question.qid]: answer } });
  }
})();
void answering.catch(() => undefined);

async function turn(text: string): Promise<any> {
  assert.ok(++turns <= 6, "Live model turn budget exceeded");
  const start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: session, text })).status, "streaming");
  const done = (await client.from(start, (frame) => isEvent(frame, "message.complete", session), long)).params.payload;
  console.log(`TURN ${turns} ${done.status}: ${done.text}`);
  return done;
}

try {
  session = (await client.call("session.create", { profile: "pi", cwd: work, source: "tui" })).session_id;
  await client.call("slash.exec", { session_id: session, command: "/mode ask" });
  await turn('Call codemode exactly once with code: text(await tools.bash({command: "printf denied > denied.txt"})). Do not call bash directly. Do not retry a blocked call or use another tool. Then say done.');
  assert.equal(cards, 1);
  assert.equal(existsSync(join(work, "denied.txt")), false);
  const file = (await provider.history(session, work)).read?.file;
  assert.ok(file);
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(entries.some((entry) => entry.message?.toolName === "codemode" && entry.message.nestedCalls?.calls?.some((call: any) => call.name === "bash" && call.status === "error")), "A nested codemode bash call was blocked");
  if (!nestedOnly) {
    answer = "Allow once";
    await turn('Use the write tool exactly once to create allowed.txt containing "allowed". Do not run commands. Then say done.');
    assert.equal(cards, 2);
    assert.equal(readFileSync(join(work, "allowed.txt"), "utf8").trim(), "allowed");
    await client.call("session.set_mode", { session_id: session, mode: "edits" });
    await turn('Use the write tool once to create edits.txt containing "edits". Do not run commands. Then say done.');
    assert.equal(cards, 2);
    assert.equal(readFileSync(join(work, "edits.txt"), "utf8").trim(), "edits");
    stop = true;
    const stopped = await turn('Use bash once to run "printf stopped > stopped.txt". Do not retry or use other tools.');
    assert.equal(cards, 3);
    assert.equal(stopped.status, "interrupted");
    assert.equal(existsSync(join(work, "stopped.txt")), false);
    stop = false;
    await client.call("session.set_mode", { session_id: session, mode: "plan" });
    await turn("Read read.txt, then create plan.txt. If your mode prevents creating it, just describe a plan in one sentence.");
    assert.equal(cards, 3);
    assert.equal(existsSync(join(work, "plan.txt")), false);
    await client.call("session.set_mode", { session_id: session, mode: "default" });
    await turn('Use write once to create default.txt containing "default". Then say done.');
    assert.equal(cards, 3);
    assert.equal(readFileSync(join(work, "default.txt"), "utf8").trim(), "default");
  }
  console.log(`PASS Pi ${version}, ${model}: ${turns} turns, ${cards} cards; scratch ${run}`);
} finally {
  await client.close();
  await bridge.dispose();
  for (const pid of readFileSync(join(run, "pids"), "utf8").trim().split("\n")) assert.throws(() => process.kill(Number(pid), 0), "A Pi process was left running");
}
