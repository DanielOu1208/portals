import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { onTestCleanup, test } from "./opencode-test.ts";
import { OpenCodeProvider } from "../src/providers/opencode/provider.ts";
import { inboxRetentionLimit } from "../src/providers/opencode/inbox.ts";
import type { Provider } from "../src/providers/types.ts";
import type { FormInfo } from "@opencode/client";
import { isEvent, startTestBridge, TestClient, type Frame, type TestBridge } from "./helpers.ts";
import { FakeOpenCode, recordedMessages } from "./opencode-serve.ts";

// OpenCode threads through the whole bridge, as the app sees them, against a stand-in
// for an OpenCode 2 server (test/opencode-serve.ts) that plays turns recorded from
// OpenCode 2.2.5: OpenCode's own client, the connection, sessions, turns and questions
// are the real code; only the server is played.

let opencode: FakeOpenCode;
let bridge: TestBridge;
let client: TestClient;
let cwd: string;
let state: string;

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

function agents(fake = opencode): Map<string, Provider> {
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent/opencode", mode: "shared", start: false, folder: cwd, logPath: join(state, "opencode-serve.log") },
    locate: async () => fake.endpoint(),
    backoff: [0.05, 0.1],
  });
  return new Map([["opencode", provider]]);
}

before(async () => {
  opencode = await FakeOpenCode.start();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "portals-opencode-test-")));
  state = mkdtempSync(join(tmpdir(), "portals-opencode-state-"));
  bridge = await startTestBridge({ providers: agents(), config: { generalFolder: cwd } });
  client = await TestClient.open(bridge);
}, { timeout: 60_000 });

after(async () => {
  // Close independent fixtures together so a stuck bridge cannot retain its server.
  await Promise.all([client?.close(), bridge?.dispose(), opencode?.close()]);
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  if (state) rmSync(state, { recursive: true, force: true });
}, { timeout: 60_000 });

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createThread(params: Record<string, unknown> = {}): Promise<string> {
  return (await client.call("session.create", { profile: "opencode", source: "tui", cwd, ...params })).session_id;
}

/** Sends a message that plays `fixture`, and returns where the thread's frames start. */
async function send(thread: string, text: string, fixture: string, options: { holdBefore?: string; dropBefore?: string } = {}): Promise<number> {
  opencode.queueTurn(thread, fixture, options);
  const start = client.frames.length;
  const reply = await client.call("prompt.submit", { session_id: thread, text, profile: "opencode" });
  assert.ok(reply.status === "streaming" || reply.status === "queued", `unexpected admission: ${reply.status}`);
  return start;
}

function turnEvents(thread: string, start: number): Frame[] {
  return client.frames.slice(start).filter((frame) => frame.method === "event" && frame.params.session_id === thread).map((frame) => frame.params);
}

async function completed(thread: string, start: number): Promise<Frame> {
  return (await client.from(start, (frame) => isEvent(frame, "message.complete", thread))).params;
}

function texts(events: Frame[], type: string): string {
  return events.filter((event) => event.type === type).map((event) => event.payload.text).join("");
}

test("OpenCode is one agent, its models those OpenCode has turned on, by provider, with their thinking levels", async () => {
  const profiles = (await client.call("profiles.list")).profiles;
  const listed = profiles.find((profile: Frame) => profile.name === "opencode");
  assert.equal(listed.kind, "opencode");
  assert.equal(listed.display_name, "OpenCode");
  const options = await client.call("model.options", { profile: "opencode" });
  assert.deepEqual(
    options.providers.map((provider: Frame) => [provider.slug, provider.name, provider.models]),
    [
      ["opencode", "OpenCode Zen", ["opencode/deepseek-v4.1-flash-free", "opencode/claude-sonnet-5"]],
      ["anthropic", "Anthropic", ["anthropic/claude-sonnet-5"]],
    ],
  );
  assert.equal(options.model, "opencode/deepseek-v4.1-flash-free");
  assert.equal(options.provider, "opencode");
  // The list is asked of OpenCode for the General folder.
  const asked = opencode.callsOf("GET", /^\/api\/model$/).at(-1)!;
  assert.ok(decodeURIComponent(asked.query.toString()).includes(cwd));
});

test("session.create makes an OpenCode session in the folder, with the chosen model, and its id is the thread's", async () => {
  const created = await client.call("session.create", { profile: "opencode", source: "tui", cwd, title: "Probe" });
  const call = opencode.callsOf("POST", /^\/api\/session$/).at(-1)!;
  assert.deepEqual(call.body.location, { directory: cwd });
  assert.deepEqual(call.body.model, { id: "deepseek-v4.1-flash-free", providerID: "opencode" });
  assert.ok(opencode.sessions.has(created.session_id));
  // The app's title is OpenCode's too.
  await until(() => opencode.sessions.get(created.session_id)?.info.title === "Probe");
});

test("a thread's model and thinking level are switched in OpenCode, the level as the model's variant", async () => {
  const thread = await createThread();
  const switched = () => opencode.callsOf("POST", new RegExp(`^/api/session/${thread}/model$`)).map((call) => call.body.model);
  await client.call("config.set", { key: "model", value: "claude-sonnet-5 --provider anthropic --session", session_id: thread });
  await client.call("config.set", { key: "reasoning", value: "high", session_id: thread });
  assert.deepEqual(switched(), [
    { id: "claude-sonnet-5", providerID: "anthropic", variant: "default" },
    { id: "claude-sonnet-5", providerID: "anthropic", variant: "high" },
  ]);
  // The level is kept for a model that has it, and dropped for one that has none.
  await client.call("config.set", { key: "model", value: "deepseek-v4.1-flash-free --provider opencode --session", session_id: thread });
  assert.deepEqual(switched().at(-1), { id: "deepseek-v4.1-flash-free", providerID: "opencode", variant: "high" });
  await client.call("config.set", { key: "model", value: "claude-sonnet-5 --provider opencode --session", session_id: thread });
  assert.deepEqual(switched().at(-1), { id: "claude-sonnet-5", providerID: "opencode", variant: "default" });
});
test("a reply streams as OpenCode sent it, once, and the turn ends complete with how full the context is", async () => {
  const thread = await createThread();
  const start = await send(thread, "Reply with exactly this sentence and nothing else: hello from opencode two.", "plain");
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "complete");
  assert.equal(done.payload.text, "hello from opencode two.");
  // The last step's tokens, of the model's context as OpenCode lists it.
  assert.deepEqual(done.payload.usage, { context_used: 3485 + 1920 + 8, context_max: 128_000 });
  const events = turnEvents(thread, start);
  // The text's delta and its end both say it: told once.
  assert.equal(texts(events, "message.delta"), "hello from opencode two.");
  assert.equal(events.filter((event) => event.type === "message.start").length, 1);
  const prompt = opencode.callsOf("POST", new RegExp(`^/api/session/${thread}/prompt$`)).at(-1)!;
  assert.deepEqual(prompt.body, { id: prompt.body.id, text: "Reply with exactly this sentence and nothing else: hello from opencode two." });
  assert.match(prompt.body.id, /^msg_portals_turn_/);
});

test("a command OpenCode asks to run goes to the phone with OpenCode's choices, and allowed once, it runs", async () => {
  const thread = await createThread();
  const start = await send(thread, "Use your shell tool to run exactly `echo spike-ok` and then tell me what it printed.", "approval");
  const request = await client.from(start, (frame) => frame.method === "approval");
  assert.equal(request.params.command, "echo spike-ok");
  assert.equal(request.params.description, "OpenCode wants to run this command");
  assert.deepEqual(
    request.params.options.map((option: Frame) => [option.id, option.label, option.requires_confirmation ?? false]),
    [
      ["once", "Allow once", false],
      ["always", "Always allow in this project", true],
      ["reject", "Deny", false],
    ],
  );
  // "Always" is a rule OpenCode saves for the project, not a grant for this thread.
  const always = request.params.options[1];
  assert.equal(always.effects[0].scope, "settings");
  assert.match(always.description, /allows shell echo \*.*every session in the project/);
  client.answer(request.id, { option: "once" });
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "complete");
  const reply = opencode.callsOf("POST", /\/permission\/[^/]+\/reply$/).at(-1)!;
  assert.deepEqual(reply.body, { decision: "once" });
  const events = turnEvents(thread, start);
  const tool = events.find((event) => event.type === "tool.complete")!.payload;
  assert.equal(tool.name, "terminal");
  assert.deepEqual(tool.args, { command: "echo spike-ok" });
  assert.deepEqual(tool.result, { output: "spike-ok\n", exit_code: 0 });
  assert.match(texts(events, "reasoning.delta"), /run exactly `echo spike-ok`/);
  assert.match(done.payload.text, /spike-ok/);
});

test("a no goes back to OpenCode with what was said, and the command shows as denied", async () => {
  const thread = await createThread();
  const start = await send(thread, "Run ls -la and tell me how many entries there are.", "denied");
  const request = await client.from(start, (frame) => frame.method === "approval");
  assert.equal(request.params.command, "ls -la");
  client.answer(request.id, { choice: "deny", note: "Not now. Say that you were blocked, and stop." });
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "complete");
  assert.deepEqual(opencode.callsOf("POST", /\/permission\/[^/]+\/reply$/).at(-1)!.body, { decision: "reject", message: "Not now. Say that you were blocked, and stop." });
  const tool = turnEvents(thread, start).find((event) => event.type === "tool.complete")!.payload;
  assert.equal(tool.name, "terminal");
  assert.equal(tool.result.status, "blocked");
  assert.match(tool.result.user_summary, /You denied this command/);
  assert.match(done.payload.text, /I was blocked/);
});

test("\"always\" is answered as OpenCode's always", async () => {
  const thread = await createThread();
  const start = await send(thread, "Run echo always-ok.", "always");
  const request = await client.from(start, (frame) => frame.method === "approval");
  client.answer(request.id, { option: "always" });
  assert.equal((await completed(thread, start)).payload.status, "complete");
  assert.deepEqual(opencode.callsOf("POST", /\/permission\/[^/]+\/reply$/).at(-1)!.body, { decision: "always" });
});

test("a file OpenCode asks to write shows its diff on the card, and the written file's diff on the tool", async () => {
  const thread = await createThread();
  const start = await send(thread, "Create hello.txt containing hi there.", "edit");
  const request = await client.from(start, (frame) => frame.method === "approval");
  assert.equal(request.params.description, "OpenCode wants to make this change");
  assert.match(request.params.command, /^Edit hello\.txt\n--- a\/hello\.txt\n\+\+\+ b\/hello\.txt\n@@ -0,0 \+1,1 @@\n\+hi there\n/);
  assert.doesNotMatch(request.params.command, /Index:|====/);
  client.answer(request.id, { option: "once" });
  assert.equal((await completed(thread, start)).payload.status, "complete");
  const tool = turnEvents(thread, start).find((event) => event.type === "tool.complete")!.payload;
  assert.equal(tool.name, "write_file");
  assert.equal(tool.args.path, join(cwd, "hello.txt"));
  assert.match(tool.result.diff, /\+hi there/);
});

test("stopping a turn interrupts it in OpenCode, and the turn ends interrupted", async () => {
  const thread = await createThread();
  const start = await send(thread, "Write a 600-word story about a lighthouse keeper. Do not use any tools.", "interrupt", { holdBefore: "session.step.failed" });
  await client.from(start, (frame) => isEvent(frame, "reasoning.delta", thread));
  assert.deepEqual(await client.call("session.interrupt", { session_id: thread, profile: "opencode" }), { status: "interrupted" });
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "interrupted");
  assert.equal(opencode.callsOf("POST", new RegExp(`^/api/session/${thread}/interrupt$`)).length, 1);
});

test("a turn the model's provider fails ends with OpenCode's error", async () => {
  const thread = await createThread();
  const start = await send(thread, "Hello?", "failed-upstream");
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "error");
  assert.match(done.payload.text, /requires an end-user identifier/);
});

test("Plan selects OpenCode's agent and Default restores its configured primary agent, without imposing permission rules", async () => {
  opencode.defaultAgent = "reviewer";
  const start = opencode.calls.length;
  try {
    const thread = await createThread();
    await client.call("slash.exec", { session_id: thread, command: "/mode plan" });
    assert.equal(opencode.sessions.get(thread)!.info.agent, "plan");
    await client.call("slash.exec", { session_id: thread, command: "/mode default" });
    assert.equal(opencode.sessions.get(thread)!.info.agent, "reviewer");
    const offered = await client.call("commands.catalog", { session_id: thread });
    assert.ok(offered.pairs.some((pair: string[]) => pair[0] === "/agent"));
    assert.match((await client.call("slash.exec", { session_id: thread, command: "/agent" })).output, /reviewer/);
    await client.call("slash.exec", { session_id: thread, command: "/agent build" });
    assert.equal(opencode.sessions.get(thread)!.info.agent, "build");
    await assert.rejects(client.call("slash.exec", { session_id: thread, command: "/agent explore" }), /no selectable/);
    assert.equal(opencode.calls.slice(start).filter((call) => /\/(permissions|permission)$/.test(call.path) && call.method !== "GET").length, 0);
    assert.ok(opencode.calls.slice(start).every((call) => !call.body?.permissions));
  } finally { opencode.defaultAgent = undefined; }
});

test("a folder without a Plan agent refuses Plan rather than replacing the user's permissions", async () => {
  const original = opencode.agents;
  opencode.agents = original.filter((agent) => agent.id !== "plan");
  try {
    const thread = await createThread();
    await assert.rejects(client.call("slash.exec", { session_id: thread, command: "/mode plan" }), /no selectable plan/);
    assert.equal(opencode.callsOf("POST", new RegExp(`/session/${thread}/agent$`)).length, 0);
  } finally { opencode.agents = original; }
});

test("native slash commands use OpenCode's command API and preserve their arguments", async () => {
  const thread = await createThread();
  const start = await send(thread, "/review staged changes\nand the new files", "plain");
  assert.equal((await completed(thread, start)).payload.status, "complete");
  const calls = opencode.callsOf("POST", new RegExp(`/session/${thread}/command$`));
  assert.deepEqual(calls.at(-1)!.body, { name: "review", text: "staged changes\nand the new files" });
  assert.equal(opencode.callsOf("POST", new RegExp(`/session/${thread}/prompt$`)).length, 0);
});

test("/compact has its own native inbox operation and reports manual compaction without becoming a user message", async () => {
  const thread = await createThread();
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: thread, text: "/compact" });
  assert.equal((await completed(thread, start)).payload.status, "complete");
  assert.equal(opencode.callsOf("POST", new RegExp(`/session/${thread}/prompt$`)).length, 0);
  const compact = opencode.callsOf("POST", new RegExp(`/session/${thread}/compact$`))[0].body;
  assert.deepEqual(compact, { id: compact.id, delivery: "queue" });
  assert.match(compact.id, /^msg_portals_turn_/);
  assert.ok(turnEvents(thread, start).some((event) => event.type === "session.compacted" && event.payload.trigger === "manual"));
  const failed = client.frames.length;
  await client.call("prompt.submit", { session_id: thread, text: "/compact extra instructions" });
  assert.equal((await completed(thread, failed)).payload.status, "error");
  assert.equal(opencode.callsOf("POST", new RegExp(`/session/${thread}/compact$`)).length, 1);
});

test("/usage uses native Console limits and honestly reports that API keys have no reported limits", async () => {
  const thread = await createThread();
  const report = await client.call("slash.exec", { session_id: thread, command: "/usage" });
  assert.match(report.output, /reports no Console usage limits/);
  assert.equal(opencode.callsOf("GET", /^\/api\/experimental\/usage\/limits$/).at(-1)!.query.get("location[directory]"), cwd);
  opencode.usageStatus = 503;
  try {
    await assert.rejects(client.call("slash.exec", { session_id: thread, command: "/usage" }), /did not say how much is used/);
  } finally { opencode.usageStatus = 200; }
});

test("messages sent mid-turn use the native inbox, stay pending until delivery, and can be moved back or removed", async () => {
  const thread = await createThread();
  const start = await send(thread, "Think for a while", "interrupt", { holdBefore: "session.step.failed" });
  await client.from(start, (frame) => isEvent(frame, "reasoning.delta", thread));
  const queued = await client.call("prompt.submit", { session_id: thread, text: "Use a shorter answer" });
  assert.equal(queued.status, "queued");
  const calls = () => opencode.callsOf("POST", new RegExp(`^/api/session/${thread}/prompt$`));
  await until(() => calls().length === 2);
  const native = calls()[1].body;
  assert.equal(native.delivery, "steer");
  assert.match(native.id, /^msg_portals-/);
  assert.equal(native.text, "Use a shorter answer");
  assert.deepEqual(await client.call("prompt.queue.place", { session_id: thread, queue_id: queued.queue_id, placement: "queue" }), { status: "moved" });
  assert.equal(opencode.sessions.get(thread)!.inbox.length, 0);
  assert.deepEqual(await client.call("prompt.queue.remove", { session_id: thread, queue_id: queued.queue_id }), { removed: true });
  const second = await client.call("prompt.submit", { session_id: thread, text: "A delivered steering message" });
  await until(() => calls().length === 3);
  const delivered = calls()[2].body.id;
  opencode.sessions.get(thread)!.inbox = [];
  opencode.emit({ id: "evt_delivered", type: "session.inbox.delivered", data: { sessionID: thread, inboxID: delivered } });
  await client.from(start, (frame) => isEvent(frame, "queue.changed", thread) && frame.params.payload.steered === second.queue_id);
  await client.call("session.interrupt", { session_id: thread });
  await completed(thread, start);
});

test("steering backpressure keeps unsent input in the bridge queue and recovers when receipts settle", async () => {
  const thread = await createThread();
  const start = await send(thread, "Keep thinking", "interrupt", { holdBefore: "session.step.failed" });
  await client.from(start, (frame) => isEvent(frame, "reasoning.delta", thread));
  const calls = () => opencode.callsOf("POST", new RegExp(`^/api/session/${thread}/prompt$`));
  const held: string[] = [];
  for (let n = 0; n < inboxRetentionLimit.entries; ++n) {
    held.push((await client.call("prompt.submit", { session_id: thread, text: `Steer ${n}` })).queue_id);
    await until(() => calls().length === n + 2);
  }
  const overflow = await client.call("prompt.submit", { session_id: thread, text: "Keep this until the turn ends" });
  await client.from(start, (frame) => isEvent(frame, "queue.changed", thread)
    && frame.params.payload.queued.some((entry: Frame) => entry.id === overflow.queue_id && entry.placement === "queue"));
  assert.equal(calls().length, inboxRetentionLimit.entries + 1, "capacity refusal sends nothing native");
  const snapshot = await client.call("session.resume", { session_id: thread });
  assert.deepEqual(snapshot.queued.find((entry: Frame) => entry.id === overflow.queue_id),
    { id: overflow.queue_id, text: "Keep this until the turn ends", placement: "queue" });

  const native = opencode.sessions.get(thread)!;
  const delivered = native.inbox.shift()!;
  const first = held.shift();
  opencode.emit({ id: "evt_capacity_delivery", type: "session.inbox.delivered", data: { sessionID: thread, inboxID: delivered.id } });
  await client.from(start, (frame) => isEvent(frame, "queue.changed", thread) && frame.params.payload.steered === first);
  const recovered = await client.call("prompt.submit", { session_id: thread, text: "Steering works again" });
  await until(() => calls().length === inboxRetentionLimit.entries + 2);
  assert.equal(calls().at(-1)!.body.delivery, "steer");
  held.push(recovered.queue_id);
  for (const queue_id of held) assert.deepEqual(await client.call("prompt.queue.remove", { session_id: thread, queue_id }), { removed: true });
  assert.equal(calls().filter((call) => call.body.text === "Keep this until the turn ends").length, 0);

  opencode.queueTurn(thread, "plain");
  const end = client.frames.length;
  await client.call("session.interrupt", { session_id: thread });
  await client.from(end, (frame) => isEvent(frame, "message.start", thread) && frame.params.payload.queue_id === overflow.queue_id);
  await until(() => calls().filter((call) => call.body.text === "Keep this until the turn ends").length === 1);
  assert.notEqual(calls().at(-1)!.body.delivery, "steer");
  await client.from(end, (frame) => isEvent(frame, "message.complete", thread) && frame.params.payload.status === "complete");
});

test("OpenCode forms become clarify cards and send native option values back once, including after reconnect", async () => {
  const thread = await createThread();
  const start = await send(thread, "Think for a while", "interrupt", { holdBefore: "session.step.failed" });
  await client.from(start, (frame) => isEvent(frame, "reasoning.delta", thread));
  const form: FormInfo = { id: "frm_choices", sessionID: thread, title: "Choose", fields: [{ key: "language", type: "string", required: true, options: [{ label: "TypeScript", value: "ts" }] }] };
  opencode.sessions.get(thread)!.forms.push(form);
  opencode.emit({ id: "evt_form", type: "form.created", data: { form } });
  const request = await client.from(start, (frame) => frame.method === "clarify" && frame.params.session_id === thread);
  assert.equal(request.params.questions[0].qid, "language");
  const listed = opencode.callsOf("GET", new RegExp(`^/api/session/${thread}/form$`)).length;
  opencode.dropStreams();
  await until(() => opencode.callsOf("GET", new RegExp(`^/api/session/${thread}/form$`)).length > listed);
  client.answer(request.id, { answers: { language: "TypeScript" } });
  await until(() => opencode.callsOf("POST", /\/form\/frm_choices\/reply$/).length > 0);
  assert.deepEqual(opencode.callsOf("POST", /\/form\/frm_choices\/reply$/).at(-1)!.body, { answer: { language: "ts" } });
  assert.equal(client.frames.slice(start).filter((frame) => frame.method === "clarify").length, 1);
  await client.call("session.interrupt", { session_id: thread });
  await completed(thread, start);
});

test("forms cancelled on the phone call the native cancel API; forms answered elsewhere close their cards", async () => {
  const thread = await createThread();
  const start = await send(thread, "Think for a while", "interrupt", { holdBefore: "session.step.failed" });
  await client.from(start, (frame) => isEvent(frame, "reasoning.delta", thread));
  for (const external of [false, true]) {
    const from = client.frames.length;
    const form: FormInfo = { id: `frm_${external}`, sessionID: thread, title: "Name", fields: [{ key: "name", type: "string" }] };
    opencode.sessions.get(thread)!.forms.push(form);
    opencode.emit({ id: `evt_form_${external}`, type: "form.created", data: { form } });
    const request = await client.from(from, (frame) => frame.method === "clarify");
    if (external) {
      opencode.sessions.get(thread)!.forms = [];
      opencode.emit({ id: "evt_elsewhere", type: "form.replied", data: { sessionID: thread, id: form.id, answer: { name: "Elsewhere" } } });
      await client.from(from, (frame) => isEvent(frame, "request.cancel", thread));
      assert.equal(opencode.callsOf("POST", /\/form\/frm_true\/reply$/).length, 0);
    } else {
      client.answer(request.id, { answers: null });
      await until(() => opencode.callsOf("DELETE", /\/form\/frm_false$/).length > 0);
    }
  }
  await client.call("session.interrupt", { session_id: thread });
  await completed(thread, start);
});

test("images go to OpenCode inline, as data URIs with their type", async () => {
  const thread = await createThread();
  assert.deepEqual(await client.call("image.attach_bytes", { session_id: thread, filename: "square.png", content_base64: png.toString("base64") }), { attached: true, name: "square.png" });
  const start = await send(thread, "What colour is this square?", "plain");
  await completed(thread, start);
  const prompt = opencode.callsOf("POST", new RegExp(`^/api/session/${thread}/prompt$`)).at(-1)!;
  assert.deepEqual(prompt.body.files, [{ uri: `data:image/png;base64,${png.toString("base64")}`, name: "square.png" }]);
});

test("image bytes determine MIME type even with a wrong file name, and unsupported images never reach OpenCode", async () => {
  const wrongName = await createThread();
  await client.call("image.attach_bytes", { session_id: wrongName, filename: "photo.heic", content_base64: png.toString("base64") });
  await completed(wrongName, await send(wrongName, "Describe it", "plain"));
  assert.match(opencode.callsOf("POST", new RegExp(`/session/${wrongName}/prompt$`)).at(-1)!.body.files[0].uri, /^data:image\/png;/);
  const unsupported = await createThread();
  await client.call("image.attach_bytes", { session_id: unsupported, filename: "photo.png", content_base64: Buffer.from("unsupported image bytes").toString("base64") });
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: unsupported, text: "Describe it" });
  const done = await completed(unsupported, start);
  assert.equal(done.payload.status, "error");
  assert.match(JSON.stringify(done.payload), /Convert it to JPEG, PNG, GIF or WebP/);
  assert.equal(opencode.callsOf("POST", new RegExp(`/session/${unsupported}/prompt$`)).length, 0);
});

test("a native background subagent outlives the parent's turn, owns its form cards and reconciles completion after reconnect", async () => {
  const thread = await createThread();
  const start = await send(thread, "Start background work", "interrupt", { holdBefore: "session.step.failed" });
  await client.from(start, (frame) => isEvent(frame, "reasoning.delta", thread));
  const id = "ses_background_child";
  const child = opencode.addSession({ id, parentID: thread, title: "Explore code", agent: "explore", location: { directory: cwd } });
  opencode.active.add(id);
  opencode.emit({ id: "evt_child", type: "session.created", data: { sessionID: id, parentID: thread, title: child.info.title, agent: "explore" } });
  await client.from(start, (frame) => isEvent(frame, "subagent.start", thread));
  for (const [type, data] of [
    ["session.tool.input.started", { id: "call_child", name: "subagent" }],
    ["session.tool.called", { id: "call_child", input: { description: "Explore code", agent: "explore", prompt: "Look around", background: true } }],
    ["session.tool.progress", { id: "call_child", metadata: { sessionID: id, status: "running" } }],
    ["session.tool.success", { id: "call_child", content: [{ type: "text", text: "Background work started" }], metadata: { sessionID: id, status: "backgrounded" } }],
  ] as const) opencode.emit({ id: `evt_${type}`, type, data: { sessionID: thread, ...data } });
  await client.call("session.interrupt", { session_id: thread, keep_background: true });
  await completed(thread, start);
  const listed = (await client.call("subagent.list", { session_id: thread })).subagents;
  assert.equal(listed.find((row: Frame) => row.subagent_id === id).status, "running");
  const form: FormInfo = { id: "frm_child", sessionID: id, title: "Name", fields: [{ key: "name", type: "string" }] };
  child.forms.push(form);
  opencode.emit({ id: "evt_child_form", type: "form.created", data: { form } });
  const request = await client.from(start, (frame) => frame.method === "clarify" && frame.params.subagent === id);
  client.answer(request.id, { answers: { name: "Done" } });
  await until(() => opencode.callsOf("POST", /\/form\/frm_child\/reply$/).length === 1);
  const before = client.frames.length;
  child.info.outcome = "succeeded";
  opencode.active.delete(id);
  opencode.dropStreams();
  const complete = await client.from(before, (frame) => isEvent(frame, "subagent.complete", thread) && frame.params.payload.subagent_id === id);
  assert.equal(complete.params.payload.status, "completed");
});

test("stopping an OpenCode child interrupts only its own native session, not its parent", async () => {
  const thread = await createThread();
  const start = await send(thread, "Start a child", "interrupt", { holdBefore: "session.step.failed" });
  await client.from(start, (frame) => isEvent(frame, "reasoning.delta", thread));
  const id = "ses_stoppable_child";
  opencode.addSession({ id, parentID: thread, location: { directory: cwd } });
  opencode.active.add(id);
  opencode.emit({ id: "evt_stop_child", type: "session.created", data: { sessionID: id, parentID: thread, title: "Child" } });
  await client.from(start, (frame) => isEvent(frame, "subagent.start", thread));
  const permission = { id: "per_stop_child", sessionID: id, action: "shell", resources: ["echo child"] };
  opencode.sessions.get(id)!.permissions.push(permission);
  opencode.emit({ id: "evt_child_approval", type: "permission.asked", data: permission });
  const card = await client.from(start, (frame) => frame.method === "approval" && frame.params.subagent === id);
  assert.deepEqual(await client.call("subagent.stop", { session_id: thread, subagent_id: id }), { status: "stopped" });
  assert.equal(opencode.callsOf("POST", new RegExp(`/session/${id}/interrupt$`)).length, 1);
  assert.equal(opencode.callsOf("POST", new RegExp(`/session/${thread}/interrupt$`)).length, 0);
  const done = await client.from(start, (frame) => isEvent(frame, "subagent.complete", thread));
  assert.equal(done.params.payload.status, "stopped");
  const cancelled = await client.from(start, (frame) => isEvent(frame, "request.cancel", thread));
  assert.equal(cancelled.params.payload.id, card.id);
  await client.call("session.interrupt", { session_id: thread });
  await completed(thread, start);
});

test("desk sessions page natively, exclude child/archive sessions, and read, continue and fork without read-only mutations", async () => {
  const readID = "ses_desk_read";
  const forkID = "ses_desk_fork";
  const updated = Date.now() + 10_000;
  for (const [id, title, time] of [[readID, "Read me", updated], [forkID, "Fork me", updated - 1]] as const) {
    opencode.addSession({ id, title, location: { directory: cwd }, time: { created: time - 1, updated: time } }, [{ id: "msg_desk", type: "user", text: "Hello from the desk", time: { created: time - 1 } }]);
  }
  opencode.addSession({ id: "ses_desk_hidden_child", parentID: readID, title: "Hidden child", location: { directory: cwd } });
  opencode.addSession({ id: "ses_desk_archived", title: "Archived", location: { directory: cwd }, time: { created: updated, updated, archived: updated } });
  opencode.active.add(readID);
  opencode.sessions.get(readID)!.forms.push({ id: "frm_desk", sessionID: readID, title: "Waiting", fields: [{ key: "name", type: "string" }] });
  const listed = (await client.call("desk.list", { profile: "opencode", limit: 100 })).sessions;
  assert.equal(listed.find((row: Frame) => row.id === readID)?.state, "waiting");
  assert.ok(listed.some((row: Frame) => row.id === forkID));
  assert.ok(!listed.some((row: Frame) => ["ses_desk_hidden_child", "ses_desk_archived"].includes(row.id)));
  assert.ok(opencode.callsOf("GET", /^\/api\/session$/).some((call) => call.query.has("cursor")));
  const before = opencode.calls.length;
  const read = await client.call("session.adopt", { profile: "opencode", session_id: readID, mode: "read" });
  assert.equal(read.session_id, readID);
  const resumed = await client.call("session.resume", { session_id: readID });
  assert.equal(resumed.running, false);
  assert.equal(resumed.messages[0].text, "Hello from the desk");
  await assert.rejects(client.call("prompt.submit", { session_id: readID, text: "Do not send" }), /only|read/i);
  assert.equal(opencode.calls.slice(before).filter((call) => call.method !== "GET").length, 0);
  opencode.active.delete(readID);
  opencode.sessions.get(readID)!.forms = [];
  await client.call("session.adopt", { profile: "opencode", session_id: readID, mode: "continue" });
  await completed(readID, await send(readID, "Continue here", "plain"));
  const fork = await client.call("session.adopt", { profile: "opencode", session_id: forkID, mode: "fork" });
  assert.notEqual(fork.session_id, forkID);
  assert.equal(opencode.callsOf("POST", new RegExp(`/session/${forkID}/fork$`)).length, 1);
  await assert.rejects(client.call("session.adopt", { profile: "opencode", session_id: "ses_desk_hidden_child", mode: "continue" }), /top-level/);
});

test("a turn sent from OpenCode's terminal on the same server shows on the phone", async () => {
  const thread = await createThread();
  const start = client.frames.length;
  opencode.play(thread, "plain");
  const begun = (await client.from(start, (frame) => isEvent(frame, "message.start", thread))).params;
  assert.ok(begun);
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "complete");
  assert.equal(done.payload.text, "hello from opencode two.");
});

test("when the event stream drops mid-turn, the rest of the reply and the turn's end are read from OpenCode once it is back", async () => {
  const thread = await createThread();
  const session = opencode.sessions.get(thread)!;
  const start = await send(thread, "Count from 1 to 80, one number per line, no other text. Do not use tools.", "reconnect");
  await opencode.settled(thread);
  await until(() => texts(turnEvents(thread, start), "message.delta").endsWith("45\n"));
  // Meanwhile OpenCode went on, and finished, while the bridge was away.
  opencode.dropStreams();
  const numbers = Array.from({ length: 80 }, (_, index) => `${index + 1}\n`).join("");
  session.messages = [
    { type: "user", id: "msg_1a384d485001HeKQbac8MAaHRw", text: "Count from 1 to 80, one number per line, no other text. Do not use tools.", time: { created: 1_793_744_750_000 } },
    { type: "assistant", id: "msg_1a384d48a001edl2EPL8KRCgoQ", content: [{ type: "text", text: numbers }], time: { created: 1_793_744_750_010, completed: 1_793_744_752_000 } },
    { type: "idle", id: "msg_idle", outcome: "succeeded", time: { created: 1_793_744_752_001 } },
  ];
  session.info.outcome = "succeeded";
  opencode.active.delete(thread);
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "complete");
  assert.equal(texts(turnEvents(thread, start), "message.delta"), numbers);
});

test("a question still waiting when the event stream comes back is the same card, answered once", async () => {
  const thread = await createThread();
  const start = await send(thread, "Use your shell tool to run exactly `echo spike-ok` and then tell me what it printed.", "approval");
  const request = await client.from(start, (frame) => frame.method === "approval");
  const asked = opencode.callsOf("GET", new RegExp(`^/api/session/${thread}/permission$`)).length;
  opencode.dropStreams();
  // Back, the bridge asks OpenCode what still waits.
  await until(() => opencode.callsOf("GET", new RegExp(`^/api/session/${thread}/permission$`)).length > asked);
  client.answer(request.id, { option: "once" });
  assert.equal((await completed(thread, start)).payload.status, "complete");
  const approvals = client.frames.slice(start).filter((frame) => frame.method === "approval");
  assert.equal(approvals.length, 1);
  assert.equal(opencode.callsOf("POST", /\/permission\/[^/]+\/reply$/).filter((call) => call.path.includes(thread)).length, 1);
});

test("a question answered in OpenCode's terminal closes on the phone", async () => {
  const thread = await createThread();
  const start = await send(thread, "Run echo always-ok.", "always");
  const request = await client.from(start, (frame) => frame.method === "approval");
  // Answered elsewhere: OpenCode says so on the stream.
  const waiting = opencode.sessions.get(thread)!.permissions[0];
  const reply = await fetch(`${opencode.url}/api/session/${thread}/permission/${waiting.id}/reply`, {
    method: "POST",
    headers: { ...opencode.endpoint().headers, "content-type": "application/json" },
    body: JSON.stringify({ decision: "once" }),
  });
  assert.equal(reply.status, 204);
  assert.equal((await completed(thread, start)).payload.status, "complete");
  // The card was withdrawn, and the bridge sent no answer of its own.
  const cancelled = turnEvents(thread, start).find((event) => event.type === "request.cancel");
  assert.equal(cancelled?.payload.id, request.id);
  assert.equal(opencode.callsOf("POST", /\/permission\/[^/]+\/reply$/).filter((call) => call.path.includes(thread)).length, 1);
});

test("a thread opened again after a restart shows OpenCode's own record of it, its tools as the phone shows them", async () => {
  const first = await startTestBridge({ keepHome: true, providers: agents(), config: { generalFolder: cwd } });
  onTestCleanup(() => first.dispose());
  const phone = await TestClient.open(first);
  onTestCleanup(() => phone.close());
  const thread = (await phone.call("session.create", { profile: "opencode", source: "tui", cwd })).session_id;
  await phone.close();
  await first.dispose();
  // What OpenCode kept of it, as the recording's session had it.
  opencode.sessions.get(thread)!.messages = recordedMessages();
  const again = await startTestBridge({ home: first.home, providers: agents() });
  onTestCleanup(() => again.dispose());
  const reopened = await TestClient.open(again);
  onTestCleanup(() => reopened.close());
  try {
    const resumed = await reopened.call("session.resume", { session_id: thread, profile: "opencode" });
    assert.equal(resumed.running, false);
    const roles = resumed.messages.map((message: Frame) => (message.role === "tool" ? `tool:${message.name}` : message.role));
    assert.deepEqual(roles, ["user", "assistant", "tool:terminal", "assistant"]);
    assert.equal(resumed.messages[0].text, "Use your shell tool to run exactly `echo spike-ok` and then tell me what it printed.");
    assert.match(resumed.messages[1].reasoning, /echo spike-ok/);
    assert.match(resumed.messages.at(-1).text, /spike-ok/);
    // Every page of it was read.
    assert.ok(opencode.callsOf("GET", new RegExp(`^/api/session/${thread}/message$`)).some((call) => call.query.get("cursor") === "2"));
  } finally {
    await reopened.close();
    await again.dispose();
  }
});

for (const active of [true, false]) test(`${active ? "active" : "idle"} restart keeps native requests recovered before any phone connects`, async () => {
  const first = await startTestBridge({ keepHome: true, providers: agents(), config: { generalFolder: cwd } });
  onTestCleanup(() => first.dispose());
  const phone = await TestClient.open(first);
  onTestCleanup(() => phone.close());
  const thread = (await phone.call("session.create", { profile: "opencode", source: "tui", cwd })).session_id;
  await phone.close();
  await first.dispose();
  const native = opencode.sessions.get(thread)!;
  native.messages = recordedMessages();
  if (active) {
    const child = opencode.addSession({ id: `ses_stopped_${thread}`, parentID: thread, outcome: "interrupted", location: { directory: cwd } });
    child.forms = [{ id: "frm_stopped_history", sessionID: child.info.id, title: "Old child form", fields: [{ key: "old", type: "string" }] }];
    native.messages.splice(native.messages.length - 1, 0, {
      type: "assistant", id: "msg_child_history", time: { created: 2 },
      content: [{ type: "tool", id: "call_child_history", name: "subagent", state: { status: "completed", input: { background: true }, metadata: { sessionID: child.info.id, status: "backgrounded" }, content: [{ type: "text", text: "Scheduled child" }] } }],
    });
    native.messages.push({ type: "user", id: "msg_restart", text: "Still working", time: { created: 3 } });
    opencode.active.add(thread);
  }
  native.permissions = [{ id: "per_restart", sessionID: thread, action: "shell", resources: ["echo harmless"] }];
  native.forms = [{ id: "frm_restart", sessionID: thread, title: "Idle or active", fields: [{ key: "answer", type: "string" }] }];
  const again = await startTestBridge({ home: first.home, providers: agents() });
  onTestCleanup(() => again.dispose());
  let reopened: TestClient | undefined;
  try {
    // Warm the thread with no connection. The broker must retain both cards.
    await until(async () => (await again.fleet.read(thread)).open_requests.length === 2);
    reopened = await TestClient.open(again);
    onTestCleanup(() => reopened!.close());
    const resumed = await reopened.call("session.resume", { session_id: thread, profile: "opencode" });
    assert.equal(resumed.running, active);
    assert.deepEqual(resumed.open_requests.map((request: Frame) => request.method).sort(), ["approval", "clarify"]);
    const later = await reopened.call("session.resume", { session_id: thread, profile: "opencode" });
    assert.deepEqual(later.open_requests.map((request: Frame) => request.id), resumed.open_requests.map((request: Frame) => request.id));
    assert.equal(opencode.callsOf("POST", /\/permission\/per_restart\/reply$/).filter((call) => call.path.includes(thread)).length, 0);
  } finally {
    await reopened?.close();
    await again.dispose();
    opencode.active.delete(thread);
  }
});
