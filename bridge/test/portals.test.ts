import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSocketFolder, parseConfig, pathsFor, socketPath } from "../src/config.ts";
import { commandAccess, onPath, threadVariables } from "../src/portals/access.ts";
import { agentInstructions, mathInstructions, visualInstructions } from "../src/portals/guide.ts";
import { queryOptions } from "../src/providers/claude/options.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { Prompt } from "../src/providers/types.ts";
import { startTestBridge, temporaryHome, type Frame, type TestBridge } from "./helpers.ts";

// The `portals` command (docs/fleet-plan.md): run as a shell runs it, against a bridge
// reached over its local socket.

const script = fileURLToPath(new URL("../src/portals.ts", import.meta.url));

let bridge: TestBridge;

before(async () => {
  bridge = await startTestBridge({ config: { fake: { delayMs: 3 } } });
});

after(() => bridge.dispose());

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the command against `home`'s bridge. */
function run(args: string[], options: { home?: string; env?: Record<string, string>; command?: string[] } = {}): Promise<Ran> {
  const [program, ...first] = options.command ?? [process.execPath, script];
  const env = { ...process.env, PORTALS_BRIDGE_HOME: options.home ?? bridge.home, ...options.env };
  // Run from an agent's shell (a Codex or Cursor thread checking this), the command must not take that thread's id.
  for (const name of threadVariables) delete (env as Record<string, string | undefined>)[name];
  Object.assign(env, options.env);
  return new Promise((resolve) => {
    execFile(program, [...first, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** Runs the command and returns what it printed, as JSON. */
async function ask(args: string[], options: { env?: Record<string, string>; home?: string } = {}): Promise<Frame> {
  const ran = await run(args, options);
  assert.equal(ran.code, 0, ran.stderr);
  return JSON.parse(ran.stdout);
}

test("a shell lists agents and folders, starts a thread, sends to it, reads it, waits for it and stops it", async (t) => {
  // A slow timed reply can finish while another CLI process starts on a busy Mac.
  // Hold only the turn this test stops; its wait/stop still cross the real socket.
  const startSession = FakeProvider.prototype.startSession;
  t.mock.method(FakeProvider.prototype, "startSession", async function (this: FakeProvider, ...args: Parameters<typeof startSession>) {
    const session = await startSession.apply(this, args);
    const sink = args[1];
    const startTurn = session.startTurn.bind(session);
    const interrupt = session.interrupt.bind(session);
    let held = false;
    t.mock.method(session, "startTurn", (prompt: Prompt) => {
      if (!prompt.text.endsWith("slow please")) return startTurn(prompt);
      held = true;
      sink.emit({ type: "text", text: "Waiting for interrupt." });
    });
    t.mock.method(session, "interrupt", async () => {
      if (!held) return interrupt();
      held = false;
      sink.emit({ type: "turn.end", status: "interrupted" });
      return true;
    });
    t.after(() => {
      if (held) sink.emit({ type: "turn.end", status: "interrupted" });
    });
    return session;
  });
  assert.equal((await ask(["agents"])).profiles[0].name, "fake");
  assert.equal((await ask(["folders"])).general.name, "General");

  const started = await ask(["start", "--agent", "fake", "start here", "--wait"]);
  const thread = started.thread.id;
  assert.equal(started.state, "idle");
  assert.match(started.reply, /^Hello from the fake agent\. You said: \[Portals: from the command line\] start here\.$/);

  const listed = (await ask(["threads", "--state", "idle", "--agent", "fake"])).threads.find((entry: Frame) => entry.id === thread);
  assert.equal(listed.agent_name, "Fake agent");

  const sent = await ask(["send", thread, "tool please", "--wait"]);
  assert.equal(sent.status, "streaming");
  assert.equal(sent.state, "idle");

  const reading = await ask(["read", thread, "--last", "2"]);
  assert.deepEqual(reading.messages.map((message: Frame) => message.role), ["user", "assistant", "user", "assistant", "tool", "tool", "assistant"]);

  assert.equal((await ask(["send", thread, "slow please"])).status, "streaming");
  const waited = await ask(["wait", thread, "--timeout", "20"]);
  assert.equal(waited.timed_out, true);
  assert.equal(waited.state, "working");
  assert.deepEqual(await ask(["stop", thread]), { stopped: true });
  assert.equal((await ask(["wait", thread, "--timeout", "1000"])).state, "idle");
});

test("a message says which thread the command ran in, when the bridge named it", async () => {
  const sender = (await ask(["start", "--agent", "fake", "--title", "The sender"])).thread.id;
  const target = (await ask(["start", "--agent", "fake"])).thread.id;

  await ask(["send", target, "hello over there", "--wait"], { env: { PORTALS_THREAD: sender } });
  assert.equal((await ask(["read", target])).messages[0].text, `[Portals: from Fake agent · "The sender" (thread ${sender})]\nhello over there`);
});

test("a message says which thread the command ran in when Codex or Cursor named it, one process running many threads; the bridge's own name for it comes first", async () => {
  const sender = (await ask(["start", "--agent", "fake", "--title", "The sender"])).thread.id;
  const target = (await ask(["start", "--agent", "fake"])).thread.id;
  const said = `[Portals: from Fake agent · "The sender" (thread ${sender})]`;
  await ask(["send", target, "from Codex", "--wait"], { env: { CODEX_THREAD_ID: sender } });
  await ask(["send", target, "from Cursor", "--wait"], { env: { CURSOR_CONVERSATION_ID: sender } });
  await ask(["send", target, "named twice", "--wait"], { env: { PORTALS_THREAD: sender, CODEX_THREAD_ID: target } });
  // A thread the bridge does not know (a Codex sub-agent's, say) is the command line.
  await ask(["send", target, "unknown", "--wait"], { env: { CODEX_THREAD_ID: "019a0000-0000-0000-0000-000000000000" } });
  const firstLines = (await ask(["read", target, "--last", "4"])).messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text.split("\n")[0]);
  assert.deepEqual(firstLines, [said, said, said, "[Portals: from the command line]"]);
});

test("an agent's process does not take a thread's id from the bridge's own environment, only the command's folder on its PATH", () => {
  const env = onPath({ PATH: "/usr/bin", HOME: "/h", PORTALS_THREAD: "a", CODEX_THREAD_ID: "b", CURSOR_CONVERSATION_ID: "c" }, "/portals/bin");
  assert.deepEqual(env, { PATH: `/portals/bin${delimiter}/usr/bin`, HOME: "/h" });
});

test("a message may open with a dash, threads are listed up to a limit, and a read puts what waits first", async () => {
  const thread = (await ask(["start", "--agent", "fake"])).thread.id;
  await ask(["send", thread, "- first\n- second", "--wait"]);
  await ask(["send", thread, "-x", "--wait"]);
  const reading = await ask(["read", thread, "--last", "2"]);
  assert.deepEqual(reading.messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text.split("\n").slice(1).join("\n")), ["- first\n- second", "-x"]);
  assert.deepEqual(Object.keys(reading).slice(0, 2), ["thread", "open_requests"]);
  assert.equal(Object.keys(reading).at(-1), "messages");

  await ask(["start", "--agent", "fake"]);
  const one = await ask(["threads", "--limit", "1"]);
  assert.equal(one.threads.length, 1);
  assert.ok(one.more >= 1);
  assert.equal((await run(["threads", "--limit"])).code, 2);
});

test("answer answers what a thread the command's own thread started asks, and is refused for anyone else", async () => {
  const parent = (await ask(["start", "--agent", "fake"])).thread.id;
  const env = { PORTALS_THREAD: parent };
  const approval = await ask(["start", "--agent", "fake", "approve please", "--wait"], { env });
  assert.equal(approval.state, "blocked");
  const [child, request] = [approval.thread.id, approval.open_requests[0].id];
  const outside = await run(["answer", child, request, "--choice", "deny"]);
  assert.equal(outside.code, 1);
  assert.match(JSON.parse(outside.stderr).error.message, /^Only the thread that started/);
  assert.deepEqual(await ask(["answer", child, request, "--choice", "deny", "--note", "Leave it."], { env }), { answered: true });

  const question = await ask(["start", "--agent", "fake", "ask please", "--wait"], { env });
  assert.deepEqual(await ask(["answer", question.thread.id, question.open_requests[0].id, "--answers", '{"q0":"Swift"}'], { env }), { answered: true });
  assert.match((await ask(["wait", question.thread.id])).reply, /You chose Swift\./);

  for (const args of [
    ["answer", child],
    ["answer", child, request],
    ["answer", child, request, "--choice", "deny", "--answers", "{}"],
    ["answer", child, request, "--note", "x", "--answers", "{}"],
    ["answer", child, request, "--answers", "not json"],
    ["answer", child, request, "--answers", "[1]"],
  ]) {
    const misused = await run(args, { env });
    assert.equal(misused.code, 2, args.join(" "));
    assert.match(misused.stderr, /portals answer THREAD REQUEST/);
  }
});

test("a refusal is JSON on stderr with status 1, and a command line that cannot be read is status 2", async () => {
  const refused = await run(["read", "no-such-thread"]);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.deepEqual(JSON.parse(refused.stderr), { error: { code: 4007, message: "There is no thread no-such-thread on this bridge." } });

  for (const args of [["send", "only-a-thread"], ["dance"], ["start", "no agent named"], ["wait", "x", "--timeout", "soon"], ["threads", "--loudly"]]) {
    const misused = await run(args);
    assert.equal(misused.code, 2, args.join(" "));
    assert.match(misused.stderr, /portals threads \[--state/);
  }
});

test("the guide prints with no bridge running, and a call then says the bridge is not running", async () => {
  const home = temporaryHome();
  const guide = await run(["guide"], { home });
  assert.equal(guide.code, 0);
  assert.match(guide.stdout, /portals send THREAD "text"/);
  assert.match(guide.stdout, /portals answer THREAD REQUEST/);
  assert.match(guide.stdout, /A thread you did not start you cannot answer/);

  const down = await run(["threads"], { home });
  assert.equal(down.code, 1);
  assert.match(JSON.parse(down.stderr).error.message, /^The Portals bridge is not running/);

  // Its one topic, how to write a visual, also with no bridge, and under the name it had
  // at first; another is a usage error.
  const visuals = await run(["guide", "visuals"], { home });
  assert.equal(visuals.code, 0);
  assert.match(visuals.stdout, /^portals guide visuals: /);
  assert.match(visuals.stdout, /```portals-visual title="Build time by target"\n/);
  assert.match(visuals.stdout, /--portals-series-1/);
  assert.match(visuals.stdout, /- Words first: the user reads what you wrote before the visual while you make it\./);
  assert.doesNotMatch(visuals.stdout, /Nothing is kept/);
  assert.match(visuals.stdout, /https:\/\/cdn\.jsdelivr\.net, https:\/\/unpkg\.com and\n  https:\/\/cdnjs\.cloudflare\.com only/);
  assert.doesNotMatch(visuals.stdout, /widget/i);
  assert.equal((await run(["guide", "widgets"], { home })).stdout, visuals.stdout);
  for (const args of [["guide", "nope"], ["guide", "visuals", "more"]]) {
    const misused = await run(args, { home });
    assert.equal(misused.code, 2, args.join(" "));
    assert.match(misused.stderr, /^There is no guide to /);
    assert.match(misused.stderr, /portals guide \[visuals\]/);
  }
});

test("the socket is the owner's only, and the launcher the bridge wrote reaches that bridge whatever the environment says", async () => {
  const paths = pathsFor(bridge.home);
  assert.equal(statSync(paths.socket).mode & 0o777, 0o600);
  assert.equal(statSync(paths.command).mode & 0o777, 0o755);
  assert.match(readFileSync(paths.command, "utf8"), /^#!\/bin\/sh\n/);

  const ran = await run(["agents"], { command: [paths.command], home: "/no/such/bridge" });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(JSON.parse(ran.stdout).profiles[0].name, "fake");
});

test("a bridge whose folder's path is too long for a socket listens in the user's own folder under /tmp, and only while no one else can enter it", async () => {
  const home = join(temporaryHome(), "a folder with a long name ".repeat(4).trim());
  mkdirSync(home);
  copyFileSync(join(bridge.home, "config.json"), join(home, "config.json"));
  const socket = socketPath(home);
  const folder = dirname(socket);
  assert.equal(folder, `/tmp/portals-${userInfo().uid}`);
  const long = await startTestBridge({ home });
  try {
    assert.equal(statSync(folder).mode & 0o777, 0o700);
    assert.equal((await ask(["agents"], { home })).profiles[0].name, "fake");
  } finally {
    await long.dispose();
  }
  // Open to others, it is not trusted: someone else could have put a socket there. Shown
  // on a folder of the test's own: the user's real one is shared with every bridge and
  // test running now, which a moment open to others would turn away.
  const own = mkdtempSync(join(tmpdir(), "portals-socket-"));
  try {
    checkSocketFolder(join(own, "x.sock"), false, own);
    chmodSync(own, 0o755);
    assert.throws(() => checkSocketFolder(join(own, "x.sock"), false, own), /is not a folder only you can open/);
    // Any other folder is the bridge's own, and not looked at.
    assert.doesNotThrow(() => checkSocketFolder(join(own, "x.sock")));
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});

test("a bridge that stops takes its socket with it", async () => {
  const second = await startTestBridge();
  const socket = pathsFor(second.home).socket;
  assert.ok(statSync(socket).isSocket());
  await second.dispose();
  assert.throws(() => statSync(socket), /ENOENT/);
});

test("agents are given the command's folder, the thread they are and a few lines about it, unless fleet.tellAgents is off, the line on math always, and the one on visuals unless visuals.tellAgents is off", () => {
  const paths = pathsFor("/Users/dev/Library/Application Support/portals-bridge");
  const told = commandAccess(parseConfig({}), paths);
  assert.equal(told.bin, "/Users/dev/Library/Application Support/portals-bridge/bin");
  assert.equal(told.instructions, `${agentInstructions(paths.command)}\n\n${mathInstructions}\n\n${visualInstructions(paths.command)}`);
  assert.match(told.instructions ?? "", /"\/Users\/dev\/Library\/Application Support\/portals-bridge\/bin\/portals"/);
  assert.match(told.instructions ?? "", /only when the user asks/);
  assert.match(told.instructions ?? "", /between \$\.\.\.\$/);
  // The line on visuals sends the agent to the guide by the command's full path, even when it is told nothing else of the command.
  assert.match(visualInstructions(paths.command), /`portals-visual`/);
  assert.doesNotMatch(visualInstructions(paths.command), /widget/i);
  assert.match(visualInstructions(paths.command), /not as text art in a code block/);
  assert.match(visualInstructions(paths.command), /run `"\/Users\/dev\/Library\/Application Support\/portals-bridge\/bin\/portals" guide visuals`/);
  // Words first: the agent writes what comes before a visual, then reads the guide (a
  // call, after which it plans the visual), so the user reads while it plans. Told to read
  // the guide first, Claude thought 187 s before its first word, which came with the visual.
  assert.match(visualInstructions(paths.command), /The words come first: write what you have to say before the visual, so the user reads it while you make the visual; only then run `[^`]+ guide visuals` for how to write one \(before each visual\)/);
  assert.equal(commandAccess(parseConfig({ fleet: { tellAgents: false } }), paths).instructions, `${mathInstructions}\n\n${visualInstructions(paths.command)}`);
  assert.equal(commandAccess(parseConfig({ visuals: { tellAgents: false } }), paths).instructions, `${agentInstructions(paths.command)}\n\n${mathInstructions}`);
  assert.equal(commandAccess(parseConfig({ fleet: { tellAgents: false }, visuals: { tellAgents: false } }), paths).instructions, mathInstructions);
  assert.equal(parseConfig({}).visuals.tellAgents, true);
  assert.throws(() => parseConfig({ fleet: { tellAgents: "yes" } }), /fleet\.tellAgents must be true or false/);
  assert.throws(() => parseConfig({ visuals: { tellAgents: "yes" } }), /visuals\.tellAgents must be true or false/);
  assert.throws(() => parseConfig({ visuals: true }), /visuals/);

  assert.deepEqual(onPath({ PATH: "/usr/bin", HOME: "/Users/dev" }, "/b"), { PATH: "/b:/usr/bin", HOME: "/Users/dev" });
  assert.deepEqual(onPath({}, "/b"), { PATH: "/b" });

  const setup = { claudePath: "claude", cwd: "/tmp", env: {}, model: "", permissionMode: null, effort: null, adaptiveThinking: false, canUseTool: async () => ({ behavior: "deny" as const, message: "" }) };
  assert.deepEqual(queryOptions(setup).systemPrompt, { type: "preset", preset: "claude_code" });
  assert.deepEqual(queryOptions({ ...setup, append: "About portals." }).systemPrompt, { type: "preset", preset: "claude_code", append: "About portals." });
});
