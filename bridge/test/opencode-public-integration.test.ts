import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "./opencode-test.ts";
import { OpenCodeProvider } from "../src/providers/opencode/provider.ts";
import type { ProviderEvent } from "../src/providers/types.ts";
import { FakeOpenCode } from "./opencode-serve.ts";

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function rig(t: { after(fn: () => Promise<void>): void }) {
  const folder = mkdtempSync(join(tmpdir(), "opencode-integration-"));
  const fake = await FakeOpenCode.start();
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent/opencode", mode: "shared", start: false, folder, logPath: join(folder, "serve.log"), portals: { bin: join(folder, "bin"), instructions: "Use portals when asked." } },
    env: { PATH: "/usr/bin:/bin", HOME: folder, OPENCODE_PASSWORD: "scratch-transport", PORTALS_THREAD: "old-thread" },
    locate: async () => fake.endpoint(), backoff: [0.01],
  });
  t.after(async () => { await provider.close(); await fake.close(); rmSync(folder, { recursive: true, force: true }); });
  return { folder, fake, provider };
}

const settings = { model: "opencode/deepseek-v4.1-flash-free", provider: "opencode", reasoningEffort: "" };

test("a reconnected writable thread restores shell setup before its next prompt", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const id = await provider.newThread({ cwd: folder, settings });
  const events: ProviderEvent[] = [];
  const session = await provider.startSession({ id, cwd: folder, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  session.attached?.();
  const envCalls = () => fake.callsOf("PUT", new RegExp(`/session/${id}/environment$`));
  assert.equal(envCalls().length, 1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.after(async () => { release(); });
  const original = fake.server.listeners("request")[0] as (...args: any[]) => void;
  fake.server.removeAllListeners("request");
  let preparing = false;
  fake.server.on("request", (req, res) => {
    if (req.method === "PUT" && req.url?.includes(`/session/${id}/environment`)) {
      preparing = true;
      void held.then(() => original(req, res));
    } else original(req, res);
  });
  fake.dropStreams();
  await until(() => preparing);
  fake.queueTurn(id, "plain");
  session.startTurn({ text: "A harmless recorded reply", images: [] });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fake.callsOf("POST", new RegExp(`/session/${id}/prompt$`)).length, 0);
  release();
  await until(() => events.some((event) => event.type === "turn.end"));
  assert.equal(envCalls().length, 2);
  const variables = envCalls()[1].body.variables;
  assert.equal(variables.PORTALS_THREAD, id);
  assert.ok(variables.PATH.startsWith(join(folder, "bin")));
  assert.equal(variables.OPENCODE_PASSWORD, undefined);
  const envIndex = fake.calls.indexOf(envCalls()[1]);
  assert.ok(fake.calls.findIndex((call) => call.method === "POST" && call.path.endsWith(`/session/${id}/prompt`)) > envIndex);
});

test("read-only adoption and reconnect never install shell environment or instructions", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const id = "ses_read_only";
  fake.addSession({ id, location: { directory: folder } });
  const session = await provider.resumeSession({ id, cwd: folder, settings, readOnly: true }, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  fake.dropStreams();
  await until(() => fake.callsOf("GET", /^\/api\/info$/).length > 1);
  await session.history();
  assert.equal(fake.calls.filter((call) => call.path.includes("/environment") || call.path.includes("/instructions/")).length, 0);
});

test("OpenCode's version report uses the installed policy and the actual connected server", async (t) => {
  const { provider } = await rig(t);
  assert.equal(provider.version.policy.minimum, "2.2.0");
  assert.equal(provider.version.policy.tested, "2.2.5");
  provider.version.installedIs("1.18.35");
  assert.equal(provider.version.current()?.standing, "too old");
  await provider.models();
  assert.equal(provider.version.statusLine(), "Version: OpenCode 2.2.5");
  assert.equal(provider.version.current()?.running, true);
});

test("/mcp is a host command with folder-scoped native status and sign-in guidance", async (t) => {
  const { folder, fake, provider } = await rig(t);
  fake.mcp = [
    { name: "ready", status: { status: "connected" } },
    { name: "starting", status: { status: "pending" } },
    { name: "off", status: { status: "disabled" } },
    { name: "broken", status: { status: "failed", error: "Connection refused\nTry later" } },
    { name: "private", status: { status: "needs_auth", error: "Sign in" } },
  ];
  assert.ok(provider.executes.includes("mcp"));
  const command = (await provider.commands({ id: "ses_mcp", cwd: folder }, "mcp"))[0];
  const text = await command.execute!("");
  assert.match(text, /ready: connected/);
  assert.match(text, /starting: starting/);
  assert.match(text, /off: off/);
  assert.match(text, /broken: failed \(Connection refused Try later\)/);
  assert.match(text, /private: needs sign-in/);
  assert.match(text, /opencode auth login/);
  assert.ok(decodeURIComponent(fake.callsOf("GET", /^\/api\/mcp$/)[0].query.toString()).includes(folder));
  assert.equal(fake.callsOf("GET", /^\/api\/command$/).length, 0);
  const gone = (await provider.commands({ id: "ses_gone", cwd: join(folder, "gone") }, "mcp"))[0];
  await assert.rejects(gone.execute!(""), /thread's folder.*no longer there/);
  assert.equal(fake.callsOf("GET", /^\/api\/mcp$/).length, 1);
});

test("recent folders refresh without holding the picker and include native sandboxes", async (t) => {
  const { folder, fake, provider } = await rig(t);
  fake.projects = [{ id: "project", canonical: folder, sandboxes: [join(folder, "worktree")], time: { created: 1, updated: 2, active: 300 } }];
  assert.deepEqual(await provider.recentFolders(), []);
  await until(async () => (await provider.recentFolders()).length === 2);
  assert.deepEqual(await provider.recentFolders(), [{ path: folder, lastUsed: 300 }, { path: join(folder, "worktree"), lastUsed: 300 }]);
  assert.equal(fake.callsOf("GET", /^\/api\/project$/).length, 1);
});

test("deleted sessions still reconcile when their shell setup disappears after reconnect", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const id = await provider.newThread({ cwd: folder, settings });
  const events: ProviderEvent[] = [];
  const session = await provider.startSession({ id, cwd: folder, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  session.attached?.();
  fake.sessions.delete(id);
  fake.dropStreams();
  await until(() => events.some((event) => event.type === "notice" && /deleted in OpenCode/.test(event.text)));
  assert.ok(fake.callsOf("GET", new RegExp(`/session/${id}$`)).length >= 2);
});

test("stalled thread loads bound both frame count and bytes before a fresh snapshot", async (t) => {
  const { folder, fake, provider } = await rig(t);
  for (const large of [false, true]) {
    const id = large ? "ses_large_load" : "ses_busy_load";
    fake.addSession({ id, location: { directory: folder } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    t.after(async () => { release(); });
    let reading = false;
    const original = fake.server.listeners("request")[0] as (...args: any[]) => void;
    fake.server.removeAllListeners("request");
    fake.server.on("request", (req, res) => {
      if (req.url?.startsWith("/api/agent")) { reading = true; void held.then(() => original(req, res)); }
      else original(req, res);
    });
    const loading = provider.resumeSession({ id, cwd: folder, settings }, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
    await until(() => reading);
    const native = provider as unknown as { route(event: unknown): void; pendingLoads: Map<string, { frames: unknown[]; bytes: number; overflow: boolean }> };
    for (let n = 0; n < (large ? 2 : 1025); ++n) native.route({ id: `evt_${n}`, type: "session.text.delta", data: { sessionID: "ses_other", delta: large ? "x".repeat(600_000) : "x" } });
    assert.deepEqual(native.pendingLoads.get(id), { frames: [], bytes: 0, overflow: true });
    release();
    const session = await loading;
    session.attached?.();
    assert.equal(native.pendingLoads.has(id), false);
    await session.close();
    fake.server.removeAllListeners("request");
    fake.server.on("request", original);
  }
});

test("OpenCode's skills are offered as skills, and a message that names one carries it", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const id = await provider.newThread({ cwd: folder, settings });
  const offered = await provider.commands({ id, cwd: folder });
  const graphify = offered.find((command) => command.name === "graphify");
  assert.equal(graphify?.skill, true);
  assert.equal(graphify?.description, "Graph a codebase");
  // The command of the same name wins.
  assert.equal(offered.filter((command) => command.name === "init").length, 1);
  assert.equal(offered.find((command) => command.name === "init")?.skill, false);

  const events: ProviderEvent[] = [];
  const session = await provider.startSession({ id, cwd: folder, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  session.attached?.();
  fake.queueTurn(id, "plain");
  session.startTurn({ text: "/graphify the port", images: [] });
  await until(() => events.some((event) => event.type === "turn.end"));
  const prompt = fake.callsOf("POST", new RegExp(`/session/${id}/prompt$`))[0];
  assert.deepEqual(prompt.body.skills, [{ id: "graphify", name: "graphify" }]);
  assert.equal(prompt.body.text, "/graphify the port");
});

test("skills OpenCode is still reading are waited for, the first time a folder is asked", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const whole = [...fake.skills, { id: "late", name: "late", description: "Read last", path: "/skills/late/SKILL.md" }];
  // Nothing at first, or one skill for a while: either way, all of them by 400 ms.
  for (const early of [[], fake.skills.slice(0, 1)]) {
    const cwd = mkdtempSync(join(folder, "project-"));
    fake.skills = [];
    const timers = [setTimeout(() => { fake.skills = early; }, 50), setTimeout(() => { fake.skills = whole; }, 400)];
    t.after(() => timers.forEach(clearTimeout));
    const offered = await provider.commands({ id: "ses_skills", cwd });
    assert.deepEqual(offered.filter((command) => command.skill).map((command) => command.name), ["graphify", "opencode", "late"]);
    // Read once, a folder's list is whole: the next menu asks once.
    const reads = fake.callsOf("GET", /^\/api\/skill$/).length;
    await provider.commands({ id: "ses_skills", cwd });
    assert.equal(fake.callsOf("GET", /^\/api\/skill$/).length, reads + 1);
  }
});

/** Holds every `GET /api/skill` unanswered, as a stuck OpenCode would. */
function holdSkills(t: { after(fn: () => void): void }, fake: FakeOpenCode) {
  const held: { destroyed: boolean; end(): void }[] = [];
  const original = fake.server.listeners("request")[0] as (...args: any[]) => void;
  fake.server.removeAllListeners("request");
  fake.server.on("request", (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/api/skill")) {
      fake.calls.push({ method: "GET", path: "/api/skill", query: new URLSearchParams(), body: undefined });
      held.push(res);
    } else original(req, res);
  });
  t.after(() => { for (const res of held) if (!res.destroyed) res.end(); });
  return held;
}

test("a skill list OpenCode does not answer holds neither the menu nor a message naming one", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const held = holdSkills(t, fake);
  const id = await provider.newThread({ cwd: folder, settings });
  let offered: Awaited<ReturnType<typeof provider.commands>> | undefined;
  void provider.commands({ id, cwd: folder }).then((commands) => { offered = commands; });
  // A menu waits up to 10 s, for an OpenCode only just started.
  await until(() => offered !== undefined, 11_000);
  assert.ok(offered!.some((command) => command.name === "init"));
  assert.equal(offered!.some((command) => command.skill), false);
  assert.ok(held.length > 0);
  await until(() => held.every((res) => res.destroyed)); // Given up, not left open.
  const asked = held.length;

  // A message waits 2 s at most, then goes as it would without skills.
  const events: ProviderEvent[] = [];
  const session = await provider.startSession({ id, cwd: folder, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  session.attached?.();
  fake.queueTurn(id, "plain");
  session.startTurn({ text: "/graphify the port", images: [] });
  await until(() => events.some((event) => event.type === "turn.end"));
  const prompt = fake.callsOf("POST", new RegExp(`/session/${id}/prompt$`))[0];
  assert.equal(prompt.body.text, "/graphify the port");
  assert.equal(prompt.body.skills, undefined);
  assert.ok(held.length > asked, "a folder never settled is asked again, not taken as empty");
});

test("Stop ends a message still waiting for OpenCode's skills, and sends nothing", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const held = holdSkills(t, fake);
  const id = await provider.newThread({ cwd: folder, settings });
  const events: ProviderEvent[] = [];
  const session = await provider.startSession({ id, cwd: folder, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  session.attached?.();
  fake.queueTurn(id, "plain");
  session.startTurn({ text: "/graphify the port", images: [] });
  await until(() => held.length === 1);
  const stopped = Date.now();
  assert.equal(await session.interrupt(), true);
  await until(() => events.some((event) => event.type === "turn.end"));
  // Well before the skills' own deadline.
  assert.ok(Date.now() - stopped < 1000);
  assert.deepEqual(events.filter((event) => event.type === "turn.end"), [{ type: "turn.end", status: "interrupted" }]);
  await until(() => held[0].destroyed);
  assert.equal(fake.callsOf("POST", new RegExp(`/session/${id}/prompt$`)).length, 0);
});

test("a message naming a skill waits for a turn of its own when OpenCode is busy, as one naming a command does", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const id = await provider.newThread({ cwd: folder, settings });
  const events: ProviderEvent[] = [];
  const session = await provider.startSession({ id, cwd: folder, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  session.attached?.();
  fake.queueTurn(id, "interrupt", { holdBefore: "session.step.failed" });
  session.startTurn({ text: "Keep thinking", images: [] });
  const prompts = () => fake.callsOf("POST", new RegExp(`/session/${id}/prompt$`));
  await until(() => prompts().length === 1);
  // With a picture, Dana's /graphify is a message; steered in, it would go without its skill.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  const prompt = { text: "/graphify this screen", images: [{ filename: "screen.png", data: png }] };
  const reads = fake.calls.length;
  assert.equal(await session.enqueue!(prompt, "portals-dana"), false);
  assert.equal(await session.steer!(prompt), false);
  assert.equal(fake.calls.length, reads, "nothing is read or sent for it while busy");
  assert.equal(await session.enqueue!({ ...prompt, text: "this screen" }, "portals-dana-plain"), true);
  assert.equal(prompts().at(-1)!.body.id, "msg_portals-dana-plain");
  await session.interrupt();
  await until(() => events.some((event) => event.type === "turn.end"));
});

test("a freshly started OpenCode slow to answer its first skill read still fills the menu", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const original = fake.server.listeners("request")[0] as (...args: any[]) => void;
  fake.server.removeAllListeners("request");
  let first = true;
  fake.server.on("request", (req, res) => {
    // OpenCode answers once it has read the folder's skills: 3 s, here.
    if (first && req.method === "GET" && req.url?.startsWith("/api/skill")) {
      first = false;
      const timer = setTimeout(() => original(req, res), 3000);
      t.after(() => clearTimeout(timer));
    } else original(req, res);
  });
  const offered = await provider.commands({ id: "ses_cold", cwd: folder });
  assert.deepEqual(offered.filter((command) => command.skill).map((command) => command.name), ["graphify", "opencode"]);
});

test("a skill named with capitals is offered by its name lower cased, and a message naming it carries the skill itself", async (t) => {
  const { folder, fake, provider } = await rig(t);
  fake.skills = [
    ...fake.skills,
    { id: "report", name: "Report", description: "Write Dana's weekly report", path: "/skills/report/SKILL.md" },
    { id: "graphify-upper", name: "Graphify", description: "Named like another skill", path: "/skills/Graphify/SKILL.md" },
    { id: "spaced", name: "two words", description: "A name the app cannot send", path: "/skills/spaced/SKILL.md" },
  ];
  const id = await provider.newThread({ cwd: folder, settings });
  const offered = await provider.commands({ id, cwd: folder });
  // The skill already named "graphify" keeps the name; a command's name and a spaced one are left out.
  assert.deepEqual(offered.filter((command) => command.skill).map((command) => [command.name, command.description]), [
    ["graphify", "Graph a codebase"],
    ["opencode", "Named with capitals"],
    ["report", "Write Dana's weekly report"],
  ]);

  const events: ProviderEvent[] = [];
  const session = await provider.startSession({ id, cwd: folder, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  session.attached?.();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  // As the app sends it from the menu, and with a picture, as a turn of its own sends it.
  for (const prompt of [{ text: "/report this week", images: [] }, { text: "/report this week", images: [{ filename: "chart.png", data: png }] }]) {
    const ends = events.filter((event) => event.type === "turn.end").length;
    fake.queueTurn(id, "plain");
    session.startTurn(prompt);
    await until(() => events.filter((event) => event.type === "turn.end").length === ends + 1);
    const sent = fake.callsOf("POST", new RegExp(`/session/${id}/prompt$`)).at(-1)!.body;
    assert.equal(sent.text, "/report this week");
    assert.deepEqual(sent.skills, [{ id: "report", name: "Report" }]);
  }
});

test("skills that differ only in case, none named in lower case, are offered by neither", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const first = { id: "first-report", name: "Report", description: "Dana's report", path: "/skills/first/SKILL.md" };
  const second = { id: "second-report", name: "REPORT", description: "Another report", path: "/skills/second/SKILL.md" };
  const id = await provider.newThread({ cwd: folder, settings });
  const events: ProviderEvent[] = [];
  const session = await provider.startSession({ id, cwd: folder, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  session.attached?.();
  // Whichever order OpenCode lists them in, the menu and a message agree: neither.
  for (const skills of [[first, second], [second, first]]) {
    fake.skills = skills;
    assert.equal((await provider.commands({ id, cwd: folder })).some((command) => command.name === "report"), false);
    const ends = events.filter((event) => event.type === "turn.end").length;
    fake.queueTurn(id, "plain");
    session.startTurn({ text: "/report this week", images: [] });
    await until(() => events.filter((event) => event.type === "turn.end").length === ends + 1);
    assert.equal(fake.callsOf("POST", new RegExp(`/session/${id}/prompt$`)).at(-1)!.body.skills, undefined);
  }
});
