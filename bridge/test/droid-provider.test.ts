import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
  AutonomyLevel, ContextBreakdownResultSchema, ToolConfirmationOutcome, ContextStatsAccuracy, DroidErrorType, DroidInteractionMode, ModelInfoSchema, ReasoningEffort, RequestPermissionRequestParamsSchema, SessionSettingsSchema, McpServerStatusInfoSchema,
  type CreateSessionOptions, type DroidResultMessage, type DroidStreamEvent, type MessageOptions,
  type SessionSettings as SdkSettings, type UpdateSessionSettingsRequestParams,
} from "@factory/droid-sdk/node";
import { DroidProvider } from "../src/providers/droid/provider.ts";
import { tokenTotal } from "../src/providers/droid/activity.ts";
import { forgetSession, forgetStale, localSdk, titleAnswer, titleArguments, type DroidHandle, type DroidSdk, type TitleRequest } from "../src/providers/droid/sdk.ts";
import type { DroidSession } from "../src/providers/droid/session.ts";
import type { DroidProcess } from "../src/providers/droid/processes.ts";
import { SettingRefused, type AgentRequest, type Prompt, type ProviderEvent, type RequestAnswer, type SessionOptions, type SessionSink } from "../src/providers/types.ts";
import { isEvent, startTestBridge, streamedText, TestClient } from "./helpers.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 1000; n++) { if (check()) return; await sleep(1); }
  assert.fail("Timed out waiting for the Droid stand-in.");
}

function result(id: string, interrupted = false): DroidResultMessage {
  const base = { type: "result" as const, sessionId: id, durationMs: 1, tokenUsage: null, messages: [], text: "", turnCount: 1, error: null };
  return interrupted ? { ...base, subtype: "interrupted", interrupted: true, success: false }
    : { ...base, subtype: "success", interrupted: false, success: true };
}

function specPermission() {
  return RequestPermissionRequestParamsSchema.parse({
    toolUses: [{ toolUse: { type: "tool_use", id: "spec-call", name: "ExitSpecMode", input: {} },
      confirmationType: "exit_spec_mode", details: { type: "exit_spec_mode", title: "Plan", plan: "Reply done." } }],
    options: [{ label: "Proceed once", value: "proceed_once" }, { label: "New session (Low)", value: "proceed_new_session_low" },
      { label: "Edit", value: "proceed_edit" }, { label: "Cancel", value: "cancel" }],
  });
}

function handoffNotifications(handle: Handle, target: string, toolId = "spec-call"): void {
  handle.notify({ params: { sessionId: handle.id, notification: { type: "tool_result", toolUseId: toolId,
    content: '{"approved":true,"handoff":{"isNewSession":true}}', isError: false } } });
  handle.notify({ params: { sessionId: target, notification: { type: "create_message",
    message: { id: "implementation-root", role: "user", parentId: "root" } } } });
}

type Script = (handle: Handle, text: string) => AsyncGenerator<DroidStreamEvent>;
class Handle implements DroidHandle {
  readonly id: string;
  readonly cwd: string;
  settings: SdkSettings;
  readonly options: CreateSessionOptions;
  readonly prompts: { text: string; options?: MessageOptions; model: string }[] = [];
  readonly changes: UpdateSessionSettingsRequestParams[] = [];
  script: Script | null = null;
  alive = true;
  interrupted = false;
  closed = 0;
  titles: string[] = [];
  exit: ((error: Error) => void) | null = null;
  context = { used: 100, remaining: 900, limit: 1000, accuracy: ContextStatsAccuracy.Estimated, updatedAt: new Date().toISOString() };
  commands: Awaited<ReturnType<DroidHandle["listCommands"]>> = { commands: [] };
  breakdown: Awaited<ReturnType<DroidHandle["getContextBreakdown"]>> | null = null;
  compactScript: DroidHandle["compact"] | null = null;
  addScript: DroidHandle["addUserMessage"] | null = null;
  resolveScript: DroidHandle["resolveQueuedUserMessage"] | null = null;
  private readonly notifications = new Set<{ callback: Parameters<DroidHandle["onNotification"]>[0]; type?: string }>();

  constructor(id: string, cwd: string, options: CreateSessionOptions) {
    this.id = id; this.cwd = cwd; this.options = options;
    this.settings = SessionSettingsSchema.parse({
      modelId: "small", reasoningEffort: ReasoningEffort.Off, autonomyLevel: AutonomyLevel.Off,
      interactionMode: DroidInteractionMode.Auto,
    });
  }

  stream = ((text: string, options?: MessageOptions) => {
    this.prompts.push({ text, options, model: this.settings.modelId });
    return this.respond(text);
  }) as DroidHandle["stream"];

  async *respond(text: string): AsyncGenerator<DroidStreamEvent> {
    if (this.script) { yield* this.script(this, text); return; }
    yield { type: "assistant_text_delta", messageId: `reply-${this.prompts.length}`, blockIndex: 0, text: `Reply: ${text}` };
    yield result(this.id);
  }
  async updateSettings(settings: UpdateSessionSettingsRequestParams) {
    this.changes.push(settings);
    this.settings = SessionSettingsSchema.parse({ ...this.settings, ...settings });
    return {};
  }
  /** While compacting the SDK's session is being replaced, and its own interrupt refuses (as SDK 0.9.1's does). */
  replacing = false;
  interruptsAny = 0;
  async interrupt(): Promise<void> {
    if (this.replacing) throw new Error("Session replacement is already in progress.");
    this.interrupted = true;
  }
  async interruptAny(): Promise<void> { this.interruptsAny++; }
  async close(): Promise<void> { this.closed++; this.alive = false; }
  async rename(params: Parameters<DroidHandle["rename"]>[0]): Promise<void> { this.titles.push(params.title); }
  async getContextStats() { return this.context; }
  async listCommands() { return this.commands; }
  async listSkills() { return { skills: [], projectAvailable: true }; }
  async setSkillDisabled() { return { success: true }; }
  mcpServers: Awaited<ReturnType<DroidHandle["listMcpServers"]>> = { servers: [], summary: { total: 0, connected: 0, connecting: 0, failed: 0 } };
  async listMcpServers() { return this.mcpServers; }
  async listMcpTools() { return []; }
  async toggleMcpServer() { return { success: true }; }
  async toggleMcpTool() { return { success: true }; }
  authenticateMcpServer: DroidHandle["authenticateMcpServer"] = async () => ({ success: true });
  submitMcpAuthCode: DroidHandle["submitMcpAuthCode"] = async () => ({ success: true });
  cancelMcpAuth: DroidHandle["cancelMcpAuth"] = async () => ({ success: true });
  async getContextBreakdown() {
    if (!this.breakdown) throw new Error("No fake context breakdown was scripted.");
    return this.breakdown;
  }
  async compact(params: Parameters<DroidHandle["compact"]>[0]) {
    if (!this.compactScript) throw new Error("No fake compaction was scripted.");
    this.replacing = true;
    try { return await this.compactScript(params); } finally { this.replacing = false; }
  }
  async addUserMessage(params: Parameters<DroidHandle["addUserMessage"]>[0], requestId?: string) {
    if (!this.addScript) throw new Error("No fake queued message was scripted.");
    return this.addScript(params, requestId);
  }
  async resolveQueuedUserMessage(params: Parameters<DroidHandle["resolveQueuedUserMessage"]>[0]) {
    if (!this.resolveScript) throw new Error("No fake queue resolution was scripted.");
    return this.resolveScript(params);
  }
  onNotification(callback: Parameters<DroidHandle["onNotification"]>[0], filter?: Parameters<DroidHandle["onNotification"]>[1]) {
    const entry = { callback, type: filter?.type };
    this.notifications.add(entry);
    return () => { this.notifications.delete(entry); };
  }
  notify(notification: Record<string, unknown>): void {
    for (const entry of this.notifications) if (!entry.type || entry.type === notification.type) entry.callback(notification);
  }
  connected(): boolean { return this.alive; }
  /** What Droid said the session's last call took as it loaded it (`DroidTransport.loadedUsage`). */
  loaded: unknown;
  loadedUsage(): unknown { return this.loaded; }
  onExit(listener: (error: Error) => void): () => void { this.exit = listener; return () => { this.exit = null; }; }
  /** Who answers Droid's pick lists on this process (`DroidHandle.onPickOptions`). */
  picker: Parameters<NonNullable<DroidHandle["onPickOptions"]>>[0] | undefined;
  onPickOptions(handler: Parameters<NonNullable<DroidHandle["onPickOptions"]>>[0]): void { this.picker = handler; }
  die(): void { this.alive = false; this.exit?.(new Error("Droid process exited.")); }
}

class Sdk implements DroidSdk {
  readonly handles: Handle[] = [];
  readonly opens: { id?: string; options: CreateSessionOptions; env?: Record<string, string> }[] = [];
  readonly contexts = new Map<string, string>();
  failResume = false;
  /** What each session it resumes says its last call took (`Handle.loaded`). */
  loaded: unknown;
  async open(options: CreateSessionOptions, id?: string, env?: Record<string, string>): Promise<Handle> {
    this.opens.push({ options, id, env });
    if (id && this.failResume) throw new Error("Droid session not found.");
    if (id && !this.contexts.has(id)) throw new Error("Droid session not found.");
    const session = id ?? `droid-${this.contexts.size + 1}`;
    const cwd = id ? this.contexts.get(id)! : realpathSync(options.cwd!);
    this.contexts.set(session, cwd);
    const handle = new Handle(session, cwd, options);
    if (id) handle.loaded = this.loaded;
    this.handles.push(handle);
    return handle;
  }
  async models() {
    return ["small", "large"].map((id) => ModelInfoSchema.parse({
      id, displayName: id, shortDisplayName: id, modelProvider: "factory",
      supportedReasoningEfforts: ["off", "low", "high"], defaultReasoningEffort: "low",
    }));
  }
}

class Sink implements SessionSink {
  readonly events: ProviderEvent[] = [];
  readonly requests: AgentRequest[] = [];
  answer: (request: AgentRequest, signal?: AbortSignal) => Promise<RequestAnswer> = async () => ({ kind: "withdrawn", reason: "No answer." });
  emit(event: ProviderEvent): void { this.events.push(event); }
  ask(request: AgentRequest, signal?: AbortSignal): Promise<RequestAnswer> {
    this.requests.push(request);
    return this.answer(request, signal);
  }
  async end(mark = 0) {
    await until(() => this.events.slice(mark).some((event) => event.type === "turn.end"));
    return this.events.slice(mark).filter((event) => event.type === "turn.end");
  }
}

async function rig(t: TestContext, overrides: { backgroundHoldMs?: number; interruptGraceMs?: number; now?: () => number; titleModel?: string | null; processes?: () => Promise<DroidProcess[]> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "portals-droid-test-"));
  const home = join(directory, "home");
  mkdirSync(home);
  const sdk = new Sdk();
  const provider = new DroidProvider({ command: "/not-a-real-droid", directory, idleMs: 100, maxWarm: 2, sdk, checkVersion: false, interruptGraceMs: 5, env: { ...process.env, HOME: home }, ...overrides });
  t.after(async () => { await provider.close(); rmSync(directory, { recursive: true, force: true }); });
  await provider.models();
  const options = (id = "thread"): SessionOptions => ({
    id, cwd: realpathSync(directory), settings: { model: "default", provider: "droid", reasoningEffort: "" },
  });
  const sink = new Sink();
  const session = await provider.startSession(options(), sink);
  return { directory, home, sdk, provider, options, sink, session, handle: sdk.handles[0] };
}

async function turn(session: DroidSession, sink: Sink, prompt: string | Prompt) {
  const mark = sink.events.length;
  session.startTurn(typeof prompt === "string" ? { text: prompt, images: [] } : prompt);
  return (await sink.end(mark))[0];
}

test("MCP sign-in is live-only, requires following, reports settling distinctly and redacts SDK failures", async (t) => {
  const r = await rig(t);
  await r.session.close();
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge), other = await TestClient.open(bridge);
  t.after(() => { client.close(); other.close(); });
  const { session_id } = await client.call("session.create", { profile: "droid" });
  const handle = r.sdk.handles.at(-1)!;
  handle.mcpServers.servers = [McpServerStatusInfoSchema.parse({ name: "probe", status: "failed", source: "user", serverType: "http", isManaged: false, requiresAuth: true, hasAuthTokens: false })];
  assert.deepEqual((await client.call("mcp.auth", { session_id, action: "list" })).servers.map((card: { status: string }) => card.status), ["required"]);
  assert.equal((await other.request("mcp.auth", { session_id, action: "list" })).error.code, 4001);
  assert.equal((await client.request("mcp.auth", { session_id, action: "unknown-SECRET" })).error.code, -32602);
  let complete!: (result: { success: boolean }) => void;
  handle.authenticateMcpServer = () => new Promise((resolve) => { complete = resolve; });
  const first = (await client.call("mcp.auth", { session_id, action: "start", server_name: "probe" })).servers[0];
  handle.notify({ params: { sessionId: handle.id, notification: { type: "mcp_auth_required", serverName: "probe",
    authUrl: "https://signin.example.invalid/?state=URL-SECRET", state: "SDK-SECRET", message: "MESSAGE-SECRET" } } });
  assert.match((await client.call("mcp.auth", { session_id, action: "list" })).servers[0].url, /URL-SECRET/);
  await client.call("mcp.auth", { session_id, action: "cancel", server_name: "probe", auth_id: first.auth_id });
  const settling = await client.request("mcp.auth", { session_id, action: "start", server_name: "probe" });
  assert.equal(settling.error.code, -32602);
  assert.deepEqual(settling.error.data, { reason: "settling" });
  const stale = await client.request("mcp.auth", { session_id, action: "submit", server_name: "probe", auth_id: first.auth_id, code: "CODE-SECRET" });
  assert.equal(stale.error.code, -32602); assert.equal(stale.error.data, undefined);
  complete({ success: false }); await sleep(0);
  const second = (await client.call("mcp.auth", { session_id, action: "start", server_name: "probe" })).servers[0];
  handle.notify({ params: { sessionId: handle.id, notification: { type: "mcp_auth_required", serverName: "probe",
    authUrl: "https://signin.example.invalid/?state=URL-SECRET", state: "SDK-SECRET" } } });
  handle.submitMcpAuthCode = async () => { throw new Error("SDK-SECRET CODE-SECRET https://signin.example.invalid/"); };
  const failed = await client.request("mcp.auth", { session_id, action: "submit", server_name: "probe", auth_id: second.auth_id, code: "CODE-SECRET" });
  assert.equal(failed.error.code, -32603); assert.equal(failed.error.data, undefined);
  assert.doesNotMatch(JSON.stringify(failed.error), /SECRET|signin\.example/);
  const snapshot = await client.call("session.resume", { session_id });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|signin\.example/);
  const events = client.events(session_id);
  assert.ok(events.some((event) => event.type === "mcp.auth"));
  for (const event of events.filter((event) => event.type === "mcp.auth")) assert.deepEqual(event.payload, {});
  assert.doesNotMatch(JSON.stringify(events), /SECRET|signin\.example/);
  assert.doesNotMatch(JSON.stringify(r.provider.store.read(session_id)), /SECRET|signin\.example/);
  assert.equal(handle.prompts.length, 0, "sign-in never calls the model");
});

test("MCP authentication keeps its process warm; list after cooling never reopens it", async (t) => {
  const r = await rig(t);
  r.handle.mcpServers.servers = [McpServerStatusInfoSchema.parse({ name: "probe", status: "failed", source: "user", serverType: "http", isManaged: false, requiresAuth: true, hasAuthTokens: false })];
  r.handle.authenticateMcpServer = () => new Promise(() => undefined);
  const { servers: [card] } = await r.session.mcpAuth({ action: "start", server_name: "probe" });
  await r.session.cool();
  assert.equal(r.handle.closed, 0, "an active browser flow keeps its host callback process alive");
  await r.session.mcpAuth({ action: "cancel", server_name: "probe", auth_id: card.auth_id });
  await r.session.cool();
  assert.equal(r.handle.closed, 1);
  const opens = r.sdk.opens.length;
  assert.equal((await r.session.mcpAuth({ action: "list" })).servers[0].status, "cancelled");
  assert.equal(r.sdk.opens.length, opens, "refreshing live cards never opens a cold process");
});

test("the pool cannot cool an MCP start while its server metadata lookup is pending", async (t) => {
  const r = await rig(t);
  const lookup = gate();
  r.handle.listMcpServers = async () => { await lookup.promise; return r.handle.mcpServers; };
  r.handle.mcpServers.servers = [McpServerStatusInfoSchema.parse({ name: "probe", status: "failed", source: "user", serverType: "http", isManaged: false, requiresAuth: true, hasAuthTokens: false })];
  r.handle.authenticateMcpServer = () => new Promise(() => undefined);
  const starting = r.session.mcpAuth({ action: "start", server_name: "probe" });
  await sleep(0);
  assert.equal(r.session.busy, true);
  await r.session.cool();
  assert.equal(r.handle.closed, 0);
  lookup.resolve();
  assert.equal((await starting).servers[0].status, "starting");
});

test("skills and MCP commands preserve our validation but never expose SDK error text", async (t) => {
  const r = await rig(t);
  r.handle.listSkills = async () => { throw new Error("https://auth.invalid/?code=SECRET-code&state=SECRET-state"); };
  r.handle.listMcpServers = async () => { throw new Error("SECRET-state SECRET-code"); };
  for (const kind of ["skills", "mcp"] as const) {
    await assert.rejects(r.session.controlsCommand(kind, ""), (error: Error) => {
      assert.doesNotMatch(error.message, /SECRET|https:/);
      assert.match(error.message, /could not read or change/);
      return true;
    });
  }
  await assert.rejects(r.session.controlsCommand("skills", "bad usage"), /Use \/skills/);
});

test("a warm Droid fork preserves the source handle and mapping, and holds off another turn until copied", async (t) => {
  const r = await rig(t);
  await turn(r.session, r.sink, "before the fork");
  const before = readFileSync(r.provider.store.file("thread")!);
  const copied = gate();
  t.after(() => copied.resolve());
  (r.handle as DroidHandle).fork = async (title) => { assert.equal(title, "Fork title"); await copied.promise; return "new-native-session"; };
  const fork = r.session.fork("Fork title");
  assert.equal(r.session.busy, true);
  assert.throws(() => r.session.startTurn({ text: "too early", images: [] }), /fork to finish/);
  await assert.rejects(r.session.fork("another"), /finish before forking/);
  copied.resolve();
  const made = await fork;
  assert.equal(made?.id, "new-native-session");
  assert.equal(made?.warm, true);
  assert.deepEqual(made?.thread, JSON.parse(before.toString()));
  assert.equal(r.handle.alive, true);
  assert.deepEqual(readFileSync(r.provider.store.file("thread")!), before);
  await turn(r.session, r.sink, "after the fork");
  assert.equal(r.sdk.opens.length, 1);
  assert.equal(r.provider.store.read("thread").session, r.handle.id);
});

test("a Droid fork refuses a running source, and a cold source asks for a snapshot instead", async (t) => {
  const r = await rig(t);
  const running = gate();
  t.after(() => running.resolve());
  r.handle.script = async function* () { await running.promise; yield result(r.handle.id); };
  r.session.startTurn({ text: "wait", images: [] });
  await assert.rejects(r.session.fork("no"), /finish before forking/);
  running.resolve();
  await r.sink.end();
  await r.session.cool();
  assert.equal(await r.session.fork("cold"), null);
  const copied = gate();
  t.after(() => copied.resolve());
  const fork = r.session.fork("cold", async (thread) => {
    assert.equal(thread?.session, r.handle.id);
    await copied.promise;
    return "cold-native-fork";
  });
  assert.equal(r.session.busy, true);
  assert.throws(() => r.session.startTurn({ text: "too early", images: [] }), /fork to finish/);
  copied.resolve();
  assert.equal((await fork)?.warm, false);
  assert.equal(r.session.busy, false);
});

test("a Droid thread is titled by its first line at once, then by the name Droid makes, also after the turn; a name of the user's stays", async (t) => {
  const r = await rig(t);
  const titles = (sink = r.sink) => sink.events.flatMap((event) => (event.type === "title" ? [event.title] : []));
  const named = (handle: Handle, title: string, updateType?: string) =>
    handle.notify({ params: { sessionId: handle.id, notification: { type: "session_title_updated", title, ...(updateType ? { updateType } : {}) } } });
  await turn(r.session, r.sink, "[Portals: from Codex in Fix login]\nplease fix the login\nit fails");
  assert.deepEqual(titles(), ["please fix the login"]);
  // Droid's own first line says who sent it: the bridge's is kept.
  named(r.handle, "[Portals: from Codex in Fix login] please fix the login", "first_user_message");
  // Its name comes a moment after the turn, when nothing is streamed any more.
  named(r.handle, "Fix the login", "llm_generated");
  // A child's session names only itself.
  r.handle.notify({ params: { sessionId: "child", notification: { type: "session_title_updated", title: "Child work", updateType: "llm_generated" } } });
  assert.deepEqual(titles(), ["please fix the login", "Fix the login"]);
  // A Droid too old to say which kind of name it is: taken as its own.
  named(r.handle, "Fix the login form");
  assert.deepEqual(titles().at(-1), "Fix the login form");
  // The user's name stays, Droid's echo of it changes nothing, and a name Droid makes after it is passed over.
  await r.session.rename("Mine");
  assert.deepEqual(r.handle.titles, ["Mine"]);
  named(r.handle, "Mine", "manual_rename");
  named(r.handle, "Fix the login again", "llm_generated");
  assert.deepEqual(titles(), ["please fix the login", "Fix the login", "Fix the login form"]);
  // Renamed in Droid itself: the user's too.
  named(r.handle, "Renamed in Droid", "manual_rename");
  assert.deepEqual(titles().at(-1), "Renamed in Droid");
  named(r.handle, "Fix the login once more", "llm_generated");
  assert.deepEqual(titles().at(-1), "Renamed in Droid");
  // A later message titles nothing.
  await turn(r.session, r.sink, "and the logout");
  assert.deepEqual(titles().at(-1), "Renamed in Droid");

  // Started with a title (portals start --title): Droid's name does not replace it.
  const sink = new Sink();
  const titled = await r.provider.startSession({ ...r.options("titled"), title: "Given" }, sink);
  await turn(titled, sink, "do the thing");
  named(r.sdk.handles.at(-1)!, "Do the thing", "llm_generated");
  assert.deepEqual(titles(sink), []);
});

test("a Droid thread is named as a Codex thread is, after its first message: the bridge's name wins over Droid's own, which stands in when none comes", async (t) => {
  const r = await rig(t);
  const sdk: DroidSdk = r.sdk;
  const titles = (sink = r.sink) => sink.events.flatMap((event) => (event.type === "title" ? [event.title] : []));
  const named = (handle: Handle, title: string, updateType = "llm_generated") =>
    handle.notify({ params: { sessionId: handle.id, notification: { type: "session_title_updated", title, updateType } } });
  const asked: TitleRequest[] = [];
  let answer = gate();
  let made: string | Error = "Fix the login form";
  sdk.title = async (request) => {
    asked.push(request);
    await answer.promise;
    if (made instanceof Error) throw made;
    return made;
  };
  await turn(r.session, r.sink, "[Portals: from Codex in Fix login]\nplease fix the login\nit fails");
  assert.deepEqual(titles(), ["please fix the login"]);
  // One request, off the turn's path (the turn ended without it), on the thread's model at its least effort.
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.model, "small");
  assert.equal(asked[0]!.effort, "off");
  assert.match(asked[0]!.prompt, /User: please fix the login\nit fails\n<\/conversation>/);
  assert.doesNotMatch(asked[0]!.prompt, /Portals: from/);
  assert.equal(asked[0]!.cwd, realpathSync(join(r.directory, "names")));
  // Droid's own name while the bridge's is on its way: kept back.
  named(r.handle, "ok");
  assert.deepEqual(titles(), ["please fix the login"]);
  answer.resolve();
  await until(() => titles().length === 2);
  assert.deepEqual(titles(), ["please fix the login", "Fix the login form"]);
  // Droid's session is given it too, and a name Droid makes later does not replace it.
  assert.deepEqual(r.handle.titles, ["Fix the login form"]);
  named(r.handle, "Fix the login form", "manual_rename");
  named(r.handle, "A sentence Droid made about the login", "llm_generated");
  assert.deepEqual(titles(), ["please fix the login", "Fix the login form"]);
  // A later message asks for no name.
  await turn(r.session, r.sink, "and the logout");
  assert.equal(asked.length, 1);

  // None comes: Droid's own stands in.
  const quiet = new Sink();
  answer = gate();
  made = new Error("Droid could not answer.");
  const second = await r.provider.startSession(r.options("second"), quiet);
  await turn(second, quiet, "reply with just ok");
  named(r.sdk.handles.at(-1)!, "ok");
  assert.deepEqual(titles(quiet), ["reply with just ok"]);
  answer.resolve();
  await until(() => titles(quiet).length === 2);
  assert.deepEqual(titles(quiet), ["reply with just ok", "ok"]);
  assert.deepEqual(r.sdk.handles.at(-1)!.titles, [], "Droid's own name is not sent back to it");

  // Renamed while the name was being made: the user's stays, and neither name replaces it.
  const renamed = new Sink();
  answer = gate();
  made = "Write the docs";
  const third = await r.provider.startSession(r.options("third"), renamed);
  await turn(third, renamed, "write docs");
  await third.rename("Mine");
  named(r.sdk.handles.at(-1)!, "Docs", "llm_generated");
  answer.resolve();
  await sleep(5);
  assert.deepEqual(titles(renamed), ["write docs"]);
  assert.deepEqual(r.sdk.handles.at(-1)!.titles, ["Mine"]);

  // The bridge's name is the first line itself: it stays, and Droid's later one does not replace it.
  const same = new Sink();
  answer = gate();
  made = "Fix login";
  const fourth = await r.provider.startSession(r.options("fourth"), same);
  await turn(fourth, same, "Fix login");
  answer.resolve();
  await sleep(5);
  named(r.sdk.handles.at(-1)!, "ok", "llm_generated");
  assert.deepEqual(titles(same), ["Fix login"]);

  // Started with a title: no name is asked for.
  const before = asked.length;
  const givenSink = new Sink();
  const given = await r.provider.startSession({ ...r.options("given"), title: "Given" }, givenSink);
  await turn(given, givenSink, "do the thing");
  assert.equal(asked.length, before);
});

test("droid.titleModel names Droid threads on another model, and null leaves them to Droid", async (t) => {
  for (const titleModel of ["large", null] as const) {
    const r = await rig(t, { titleModel });
    const asked: TitleRequest[] = [];
    (r.sdk as DroidSdk).title = async (request) => { asked.push(request); return "Named by the bridge"; };
    await turn(r.session, r.sink, "please fix it");
    const titles = () => r.sink.events.flatMap((event) => (event.type === "title" ? [event.title] : []));
    if (titleModel) {
      await until(() => titles().length === 2);
      assert.deepEqual(asked.map((request) => [request.model, request.effort]), [["large", "off"]]);
    } else {
      await sleep(5);
      assert.equal(asked.length, 0);
      r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "session_title_updated", title: "Fix it", updateType: "llm_generated" } } });
      assert.deepEqual(titles(), ["please fix it", "Fix it"]);
    }
  }
});

test("the one-shot droid exec that names a thread: read-only, one inert tool, its answer read from JSON, its session files removed", () => {
  const args = titleArguments({ prompt: "--Generate a title", instructions: "Titles only.", model: "glm-5.3-flash", effort: "off", cwd: "/state/droid/names" });
  assert.deepEqual(args, ["exec", "--output-format", "json", "--model", "glm-5.3-flash", "--reasoning-effort", "off",
    "--only-tools", "TodoWrite", "--append-system-prompt", "Titles only.", "--cwd", "/state/droid/names", "--", "--Generate a title"]);
  assert.ok(!args.includes("--auto") && !args.includes("--skip-permissions-unsafe"));
  assert.ok(!titleArguments({ prompt: "p", instructions: "i", model: "m", cwd: "/c" }).includes("--reasoning-effort"));
  // As droid exec 0.247.0 answers.
  const line = '{"type":"result","subtype":"success","is_error":false,"duration_ms":1634,"num_turns":1,"result":"Diagnose iPad sidebar drag flicker","session_id":"2573b143-0460-41c8-9ebd-acdf120d3e70","usage":{"input_tokens":1392}}';
  assert.deepEqual(titleAnswer(`${line}\n`), { text: "Diagnose iPad sidebar drag flicker", session: "2573b143-0460-41c8-9ebd-acdf120d3e70" });
  assert.deepEqual(titleAnswer('{"type":"result","subtype":"error","is_error":true,"result":"Model not found","session_id":"../../x"}'), { text: "Model not found", session: undefined, error: "Model not found" });
  assert.equal(titleAnswer("not json").error, "Droid gave no answer it could read.");
  const home = mkdtempSync(join(tmpdir(), "portals-droid-names-"));
  try {
    const folder = join(home, ".factory", "sessions", "-state-droid-names");
    mkdirSync(folder, { recursive: true });
    for (const name of ["s1.jsonl", "s1.settings.json", "s1.settings.json.bak", "s2.jsonl"]) writeFileSync(join(folder, name), "{}");
    forgetSession(home, "/state/droid/names", "s1");
    assert.deepEqual(readdirSync(folder), ["s2.jsonl"]);
    forgetSession(home, "/state/droid/names", "s2");
    assert.equal(existsSync(folder), false, "the emptied folder goes too");
    // Left by one stopped before it said its session: removed once old, not while it may be another's in the making.
    mkdirSync(folder, { recursive: true });
    const old = "2573b143-0460-41c8-9ebd-acdf120d3e70", fresh = "11111111-2222-3333-4444-555555555555";
    // A project at /state-droid/names has its sessions in the same folder of Droid's: they are its conversations, kept.
    const project = "22222222-3333-4444-5555-666666666666", unsure = "33333333-4444-5555-6666-777777777777";
    const started = (cwd: string) => `${JSON.stringify({ type: "session_start", id: "x", cwd })}\n{"type":"message"}\n`;
    writeFileSync(join(folder, `${old}.jsonl`), started("/state/droid/names"));
    writeFileSync(join(folder, `${fresh}.jsonl`), started("/state/droid/names"));
    writeFileSync(join(folder, `${project}.jsonl`), started("/state-droid/names"));
    for (const name of [`${old}.settings.json`, `${project}.settings.json`, `${unsure}.settings.json`, "notes.txt"]) writeFileSync(join(folder, name), "{}");
    for (const name of [`${old}.jsonl`, `${old}.settings.json`, `${project}.jsonl`, `${project}.settings.json`, `${unsure}.settings.json`, "notes.txt"]) {
      utimesSync(join(folder, name), new Date(1000), new Date(1000));
    }
    forgetStale(home, "/state/droid/names", Date.now() - 60_000);
    assert.deepEqual(readdirSync(folder).sort(), [`${fresh}.jsonl`, `${project}.jsonl`, `${project}.settings.json`, `${unsure}.settings.json`, "notes.txt"].sort());
    // A folder of Droid's there that is a link is not looked into.
    rmSync(folder, { recursive: true, force: true });
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, `${old}.jsonl`), started("/state/droid/names"));
    utimesSync(join(elsewhere, `${old}.jsonl`), new Date(1000), new Date(1000));
    symlinkSync(elsewhere, folder);
    forgetStale(home, "/state/droid/names", Date.now() - 60_000);
    assert.deepEqual(readdirSync(elsewhere), [`${old}.jsonl`]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("mid-turn a Droid thread is saved every two seconds, a long one, slower to write, less often; its turn's end at once", async (t) => {
  let now = 1_000_000;
  const r = await rig(t, { now: () => now });
  let writeMs = 1;
  const saves: number[] = [];
  const write = r.provider.store.write.bind(r.provider.store);
  r.provider.store.write = (thread) => { write(thread); now += writeMs; saves.push(now); };
  const clock = gate();
  r.handle.script = async function* (handle) {
    for (const [step, wait] of [[1, 2100], [2, 2100], [3, 0], [4, 2100], [5, 2000], [6, 2100]] as const) {
      now += wait;
      yield { type: "tool_call", name: "Read", toolUseId: `read-${step}`, input: { file_path: "/a" } };
      if (step === 3) await clock.promise;
    }
    yield result(handle.id);
  };
  const ended = turn(r.session, r.sink, "read");
  await until(() => saves.length >= 3);
  // A small thread: saved at the start of the turn, then each time two seconds have passed.
  const small = saves.length;
  assert.equal(small, 3);
  // The thread grows: its saves now take 10 ms, so the next waits 4 seconds.
  writeMs = 10;
  saves.length = 0;
  clock.resolve();
  await ended;
  // Step 4 (2.1 s on) saves and takes 10 ms; step 5 (2 s later) is too soon at 4 s; step 6 is 4.1 s on; then the turn's end.
  assert.equal(saves.length, 3);
});

test("what a naming stopped with the bridge left behind is removed when Droid's provider starts", async (t) => {
  const r = await rig(t);
  const names = join(r.directory, "names");
  mkdirSync(names);
  const folder = join(r.home, ".factory", "sessions", realpathSync(names).replaceAll("/", "-"));
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session_start", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cwd: realpathSync(names) })}\n`);
  utimesSync(file, new Date(1000), new Date(1000));
  r.provider.start();
  assert.equal(existsSync(folder), false);
});

test("a one-shot naming droid that fails still has its session files removed", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "portals-droid-namer-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, "names");
  mkdirSync(cwd);
  const session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const folder = join(home, ".factory", "sessions", cwd.replaceAll("/", "-"));
  mkdirSync(folder, { recursive: true });
  for (const suffix of [".jsonl", ".settings.json"]) writeFileSync(join(folder, `${session}${suffix}`), "{}");
  // A stand-in droid that answers as droid exec does when the model is refused, and exits 1.
  const droid = join(home, "droid");
  writeFileSync(droid, `#!/bin/sh\necho '{"type":"result","subtype":"error","is_error":true,"result":"Model not found","session_id":"${session}"}'\nexit 1\n`);
  chmodSync(droid, 0o755);
  const sdk = localSdk(droid, { HOME: home, PATH: process.env.PATH ?? "" });
  await assert.rejects(sdk.title!({ prompt: "p", instructions: "i", model: "gone", cwd }));
  assert.equal(existsSync(folder), false);
});

test("Droid saves identity before prompting, cools, and lazily resumes the same context after restart", async (t) => {
  const r = await rig(t);
  assert.equal(r.handle.prompts.length, 0);
  assert.equal(r.handle.options.disabledToolIds, undefined, "keep the CLI's native tool selection intact");
  assert.equal(r.provider.store.read("thread").session, r.handle.id);
  assert.equal((await turn(r.session, r.sink, "hello")).status, "complete");
  const stored = r.provider.store.read("thread");
  assert.deepEqual(stored.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(stored.open, false);
  const close = r.handle.close.bind(r.handle);
  r.handle.close = async () => {
    assert.equal(r.handle.options.abortSignal?.aborted, false, "await SDK shutdown before aborting its lifetime");
    await close();
  };
  await r.session.cool();
  assert.equal(r.handle.closed, 1);
  assert.equal(r.handle.options.abortSignal?.aborted, true);
  await turn(r.session, r.sink, "again");
  assert.equal(r.sdk.opens.at(-1)?.id, r.handle.id);
  await r.session.close();
  const sink = new Sink();
  const resumed = await r.provider.resumeSession(r.options(), sink);
  const before = r.sdk.opens.length;
  assert.equal((await resumed.history()).length, 4);
  assert.equal(r.sdk.opens.length, before);
  await turn(resumed, sink, "after restart");
  assert.equal(r.sdk.opens.length, before + 1);
  assert.equal(r.sdk.opens.at(-1)?.id, r.handle.id);
  assert.equal(statSync(join(r.directory, "threads")).mode & 0o777, 0o700);
});

test("a Droid thread whose file a power cut left empty comes back from the file its last save replaced, which the next save keeps; the empty one is kept aside", async (t) => {
  const r = await rig(t);
  assert.equal((await turn(r.session, r.sink, "hello")).status, "complete");
  await r.session.close();
  const folder = join(r.directory, "threads");
  const file = readdirSync(folder).find((name) => name.endsWith(".json"))!;
  const saved = r.provider.store.read("thread");
  // Each save keeps the file it replaces: the one before the last.
  const before = JSON.parse(readFileSync(join(folder, `${file}.bak`), "utf8"));
  assert.equal(before.session, saved.session);
  // Nothing waits for a save to be on the disk: after a power cut the file can be empty.
  writeFileSync(join(folder, file), "");

  const sink = new Sink();
  const resumed = await r.provider.resumeSession(r.options(), sink);
  // The save before the last was made mid-turn: the turn shows as cut off by the stop, the thread is whole.
  assert.deepEqual((await resumed.history()).map((message) => [message.role, "text" in message ? message.text : null]), [["user", "hello"], ["assistant", "The bridge stopped during this turn. Send another message to continue the saved Droid conversation."]]);
  // The next save is whole again, and the file that could not be used is kept aside, not made the backup.
  await turn(resumed, sink, "again");
  assert.equal(r.provider.store.read("thread").session, saved.session);
  assert.equal(readdirSync(folder).filter((name) => name.startsWith(`${file}.corrupt-`)).length, 1);
  assert.notEqual(readFileSync(join(folder, `${file}.bak`), "utf8"), "");
  await resumed.close();
});

test("missing execution context is an error, never a fresh replacement session", async (t) => {
  const r = await rig(t);
  await r.session.cool();
  r.sdk.failResume = true;
  const end = await turn(r.session, r.sink, "continue");
  assert.equal(end.status, "error");
  assert.match(end.error!, /not found/);
  const kept = r.provider.store.read("thread").messages;
  assert.deepEqual(kept.slice(-2).map((message) => message.role === "assistant" ? message.display_kind : message.role === "user" ? message.text : message.role), ["continue", "failed_turn"],
    "what was asked stays before the failure it met");
  assert.equal(r.sdk.opens.at(-1)?.id, r.handle.id);
  assert.equal(r.provider.store.read("thread").session, r.handle.id);
  await assert.rejects(r.provider.resumeSession(r.options("missing"), new Sink()), /mapping is missing/);
});

test("a new thread's composer is told the autonomy Droid's own settings give, once a session has shown them", async (t) => {
  const r = await rig(t);
  // The rig's sessions start at Droid's Off autonomy in normal mode: "ask".
  await turn(r.session, r.sink, "hello");
  assert.equal(r.provider.defaultMode(), "ask");
});

test("resuming a thread does not mistake its model for the user's CLI default", async (t) => {
  const r = await rig(t);
  await r.session.setModel("large", "droid");
  await r.session.cool();
  const open = r.sdk.open.bind(r.sdk);
  r.sdk.open = async (options, id) => {
    const handle = await open(options, id);
    if (id) handle.settings.modelId = "large";
    return handle;
  };
  await turn(r.session, r.sink, "resume");
  assert.equal((await r.provider.models()).names?.default, "small");
});

test("an unavailable catalog preserves the CLI's native default reasoning spelling", async (t) => {
  const r = await rig(t);
  r.provider.model = () => undefined;
  await r.session.setMode("ask");
  assert.equal(r.session.settings().reasoningEffort, "none");
  assert.equal(r.handle.settings.reasoningEffort, ReasoningEffort.Off);
});

test("Spec approval returns to the prior mode in the same session, while rejection stays read-only", async (t) => {
  for (const choice of ["once", "deny"] as const) {
    const r = await rig(t);
    await r.session.setMode("edits");
    await r.session.setMode("plan");
    const native = r.handle.id;
    r.sink.answer = async (request) => {
      assert.ok(request.kind === "approval");
      assert.deepEqual(request.plan, { startsIn: "edits" });
      return { kind: "approval", choice };
    };
    let answer: unknown;
    r.handle.script = async function* (handle) {
      answer = await handle.options.permissionHandler!(RequestPermissionRequestParamsSchema.parse({
        toolUses: [{
          toolUse: { type: "tool_use", id: "plan", name: "ExitSpecMode", input: {} },
          confirmationType: "exit_spec_mode", details: { type: "exit_spec_mode", title: "Plan", plan: "Make one change." },
        }],
        options: [{ label: "Approve", value: "proceed_once" }, { label: "Reject", value: "cancel" }],
      }));
      yield result(handle.id);
    };
    assert.equal((await turn(r.session, r.sink, "present a plan")).status, "complete");
    assert.deepEqual(answer, choice === "once" ? "proceed_once" : { selectedOption: "cancel" });
    assert.equal(r.session.mode().mode, choice === "once" ? "edits" : "plan");
    assert.equal(r.provider.store.read("thread").session, native);
    assert.equal(r.sdk.opens.length, 1);
  }
});

test("a turn cut off by bridge restart gets one stored failure and does not restart itself", async (t) => {
  const r = await rig(t);
  await r.session.close();
  const stored = r.provider.store.read("thread");
  stored.open = true;
  r.provider.store.write(stored);
  const resumed = await r.provider.resumeSession(r.options(), new Sink());
  const history = await resumed.history();
  const last = history.at(-1);
  assert.ok(last?.role === "assistant");
  assert.equal(last.display_kind, "failed_turn");
  assert.equal(r.provider.store.read("thread").open, false);
  assert.equal(r.sdk.opens.length, 1);
});

test("an oversized Droid message is a visible failed turn with the model-window reason, not a dead process (D6)", async (t) => {
  const r = await rig(t);
  const reason = "Your message is too large for the model's conversation window. The message was not sent. Save it to a file or shorten it.";
  r.handle.script = async function* (handle) {
    yield {
      type: "result", sessionId: handle.id, durationMs: 0, tokenUsage: null, messages: [], text: "", turnCount: 1,
      subtype: "error_during_execution", success: false, interrupted: false,
      error: { type: "error", message: reason, errorType: DroidErrorType.ERROR, timestamp: new Date().toISOString() },
    };
  };
  const end = await turn(r.session, r.sink, "too large");
  assert.equal(end.status, "error");
  assert.equal(end.error, reason);
  const history = await r.session.history();
  const last = history.at(-1);
  assert.ok(last?.role === "assistant");
  assert.equal(last.display_kind, "failed_turn");
  assert.equal(last.text, reason);
  assert.equal(r.handle.closed, 0, "a refusal leaves background work's process alive");
  r.handle.script = null;
  assert.equal((await turn(r.session, r.sink, "short enough")).status, "complete");
  assert.equal(r.sdk.opens.length, 1);
});

test("Droid's known steering receipt still reaches the bridge when its history cannot be saved (D14)", async (t) => {
  const r = await rig(t);
  const hold = gate();
  r.handle.script = async function* (handle) {
    yield { type: "assistant_text_delta", messageId: "reply", blockIndex: 0, text: "Working." };
    await hold.promise;
    yield result(handle.id);
  };
  r.handle.addScript = async () => ({});
  const running = turn(r.session, r.sink, "first");
  await until(() => r.handle.prompts.length === 1);
  await r.session.enqueue({ text: "steer", images: [] }, "receipt");
  const write = r.provider.store.write.bind(r.provider.store);
  r.provider.store.write = () => { throw new Error("disk full"); };
  try {
    assert.doesNotThrow(() => r.handle.notify({ params: { notification: {
      type: "create_message", requestId: "receipt", message: { role: "user", content: [{ type: "text", text: "steer" }] },
    } } }));
    assert.ok(r.sink.events.some((event) => event.type === "queue.consumed" && event.requestId === "receipt"));
    assert.ok(r.sink.events.some((event) => event.type === "notice" && /could not save.*receipt/i.test(event.text)));
  } finally {
    r.provider.store.write = write;
    hold.resolve();
    await running;
  }
  assert.equal(r.session.queuedConsumed("receipt"), true);
  assert.ok(r.provider.store.read("thread").queueReceipts?.includes("receipt"), "the turn's later save retries the receipt");
});

test("a late steering receipt opens its own turn and reconciles the failure even while both notification saves fail (D14)", async (t) => {
  const r = await rig(t);
  const hold = gate();
  r.handle.script = async function* (handle) {
    yield { type: "assistant_text_delta", messageId: "reply", blockIndex: 0, text: "Working." };
    await hold.promise;
    yield result(handle.id);
  };
  r.handle.addScript = async () => ({});
  r.handle.resolveScript = async () => ({});
  const running = turn(r.session, r.sink, "first");
  await until(() => r.handle.prompts.length === 1);
  await r.session.enqueue({ text: "steer", images: [] }, "receipt");
  hold.resolve();
  await running;
  await until(() => r.sink.events.some((event) => event.type === "queue.failed"));
  const mark = r.sink.events.length;
  const write = r.provider.store.write.bind(r.provider.store);
  r.provider.store.write = () => { throw new Error("disk full"); };
  try {
    assert.doesNotThrow(() => r.handle.notify({ params: { notification: {
      type: "create_message", requestId: "receipt", message: { id: "receipt-message", role: "user", content: [{ type: "text", text: "steer" }] },
    } } }));
    const events = r.sink.events.slice(mark);
    const begin = events.findIndex((event) => event.type === "turn.begin");
    const taken = events.findIndex((event) => event.type === "queue.taken");
    assert.ok(begin >= 0 && taken > begin, "the own turn opens before the late receipt reaches the bridge");
    assert.ok(events.some((event) => event.type === "notice" && /could not save.*receipt/i.test(event.text)));
  } finally {
    r.provider.store.write = write;
  }
  r.handle.notify({ params: { notification: {
    type: "agent_turn_completed", turnId: "receipt", reason: "completed",
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 },
  } } });
  await until(() => r.sink.events.slice(mark).some((event) => event.type === "turn.end"));
  assert.ok(r.provider.store.read("thread").queueReceipts?.includes("receipt"));
});

test("Spec handoff atomically maps the target, preserves display history/settings, and resumes the replacement", async (t) => {
  const r = await rig(t);
  await turn(r.session, r.sink, "history before planning");
  await r.session.setModel("large", "droid");
  await r.session.setReasoning("high");
  await r.session.setMode("plan");
  r.sdk.contexts.set("implementation", r.handle.cwd);
  r.sink.answer = async (request) => {
    assert.ok(request.kind === "approval");
    assert.equal(request.planContent, "Reply done.");
    assert.ok(request.options?.some((o) => o.id === "proceed_new_session_low" && o.requiresConfirmation));
    return { kind: "approval.option", option: "proceed_new_session_low" };
  };
  r.handle.script = async function* (handle) {
    assert.deepEqual(await handle.options.permissionHandler!(specPermission()), { selectedOption: "proceed_new_session_low" });
    handoffNotifications(handle, "implementation");
    handle.notify({ params: { sessionId: "implementation", notification: { type: "agent_turn_completed",
      cumulativeTokenUsage: { inputTokens: 30, outputTokens: 2, factoryCredits: 1 } } } });
    yield { type: "token_usage_update", inputTokens: 999, outputTokens: 99, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 };
    assert.equal(r.provider.store.read("thread").session, "implementation", "mapping is durable while the source stream is still active");
    yield { type: "assistant_text_delta", messageId: "implementation-answer", blockIndex: 0, text: "Implementation reply" };
    yield result(handle.id);
  };
  const end = await turn(r.session, r.sink, "present a plan");
  assert.equal(end.status, "complete");
  const stored = r.provider.store.read("thread");
  assert.equal(stored.session, "implementation");
  assert.equal(stored.previousSession, r.handle.id);
  assert.deepEqual(stored.formerSessions, [r.handle.id]);
  assert.equal(stored.mode, "edits");
  assert.deepEqual(stored.settings, { model: "large", provider: "droid", reasoningEffort: "high" });
  assert.equal(stored.sessionTokens, 32, "unscoped SDK updates from the source cannot overwrite the confirmed target baseline");
  assert.equal(stored.sessionCredits, 1);
  assert.ok(stored.messages.some((m) => m.role === "user" && m.text === "history before planning"));
  assert.ok(stored.messages.some((m) => m.role === "assistant" && m.text === "Implementation reply"));
  assert.equal(r.sdk.opens.at(-1)?.id, "implementation");
  assert.equal(r.handle.closed, 1);
  const target = r.sdk.handles.at(-1)!;
  await turn(r.session, r.sink, "follow up");
  assert.equal(target.prompts.at(-1)?.text, "follow up");
});

for (const name of ["Task", "Execute"] as const) for (const disposition of ["settled", "expired", "next-prompt"] as const) {
  test(`Spec handoff preserves background ${name} until ${disposition} and only streams follow-ups to the target`, async (t) => {
    let now = 0;
    const r = await rig(t, { backgroundHoldMs: 1000, now: () => now });
    await r.session.setMode("plan");
    r.sdk.contexts.set("implementation", r.handle.cwd);
    r.sink.answer = async () => ({ kind: "approval.option", option: "proceed_new_session_low" });
    r.handle.script = async function* (handle) {
      await handle.options.permissionHandler!(specPermission());
      handoffNotifications(handle, "implementation");
      yield { type: "tool_call", name, toolUseId: "job", input: name === "Task" ? { await: false } : { fireAndForget: true } };
      if (name === "Task") handle.notify({ params: { sessionId: "implementation",
        notification: { type: "child_session_available", toolUseId: "job", childSessionId: "child" } } });
      yield { type: "tool_result", toolUseId: "job", toolName: name, isError: false, content: name === "Task"
        ? "Task launched in background.\nsession_id: child\nsubagent_type: explorer" : "Background process started (PID: 1)" };
      yield result(handle.id);
    };
    await turn(r.session, r.sink, "plan and implement");
    assert.equal(r.provider.store.read("thread").session, "implementation");
    assert.equal(r.handle.closed, 0, "the live implementation process is not replaced at stream end");
    assert.equal(r.sdk.opens.length, 1);
    assert.equal(r.session.hasBackgroundWork(), true);
    assert.deepEqual(r.sink.events.filter((event) => event.type === "notice"
      && event.text.startsWith("Background work continues")), [{
      type: "notice", level: "info",
      text: "Background work continues in the new session. Portals can't see when it finishes until you send another message.",
    }]);
    if (disposition === "settled") {
      r.handle.notify({ params: { sessionId: "implementation", notification: { type: "create_message", message: {
        id: name === "Task" ? "task-completion:job" : "execute-completion:job",
        role: name === "Task" ? "system" : "user", visibility: "llm_only",
        content: [{ type: "text", text: name === "Task"
          ? "Background task completed.\ntask_id: child\nreason: completed\noutput: Finished"
          : "Background Execute command finished.\ntool_use_id: job\nexit_status: code 0\noutput: Finished" }],
      } } } });
      assert.equal(r.handle.closed, 0, "the automatic implementation follow-up remains protected");
      r.handle.notify({ params: { sessionId: "implementation", notification: { type: "agent_turn_completed" } } });
    } else if (disposition === "expired") {
      now = 1000;
      assert.equal(r.session.hasBackgroundWork(), false);
    } else {
      await turn(r.session, r.sink, "follow up now");
      assert.ok(r.sink.events.some((event) => event.type === "notice" && event.level === "info"
        && event.text === "Portals stopped tracking background work from the plan; it may already have finished."));
      const finalTracking = name === "Task"
        ? r.provider.store.read("thread").subagents![0].result
        : JSON.stringify(r.sink.events.findLast((event) => event.type === "tool.end" && event.id.startsWith("job#bg-")));
      assert.match(finalTracking!, /tracking ended.*may already have finished/i);
      assert.doesNotMatch(finalTracking!, /work stopped|process stopped/i);
      assert.equal(r.sdk.handles.at(-1)!.prompts.at(-1)?.text, "follow up now");
      assert.equal(r.handle.prompts.length, 1, "the source handle never receives the next prompt");
    }
    await until(() => r.sdk.handles.length === 2);
    assert.equal(r.handle.closed, 1);
    assert.equal(r.sdk.opens.at(-1)?.id, "implementation");
    if (name === "Task") assert.equal(r.provider.store.read("thread").subagents![0].status,
      disposition === "settled" ? "completed" : "stopped");
    else if (disposition !== "settled") assert.ok(r.sink.events.some((event) => event.type === "tool.end"
      && event.id.startsWith("job#bg-") && /tracking ended/i.test(JSON.stringify(event.result))));
  });
}

for (const invalid of ["missing-result", "wrong-tool", "missing-envelope", "wrong-envelope"] as const) {
  test(`Spec ${invalid} keeps the complete source mapping and reports the unconfirmed handoff`, async (t) => {
    const r = await rig(t);
    await r.session.setMode("plan");
    r.sink.answer = async () => ({ kind: "approval.option", option: "proceed_new_session_low" });
    r.handle.script = async function* (handle) {
      await handle.options.permissionHandler!(specPermission());
      if (invalid !== "missing-result") handle.notify({ params: { sessionId: handle.id, notification: {
        type: "tool_result", toolUseId: invalid === "wrong-tool" ? "other-tool" : "spec-call",
        content: '{"approved":true,"handoff":{"isNewSession":true}}' } } });
      if (invalid !== "missing-envelope") handle.notify({ params: { sessionId: "implementation", notification: {
        type: "create_message", message: { id: "new", role: invalid === "wrong-envelope" ? "assistant" : "user", parentId: "root" } } } });
      yield result(handle.id);
    };
    const end = await turn(r.session, r.sink, "plan");
    assert.equal(end.status, "error");
    assert.match(end.error!, /replacement session was not confirmed/);
    assert.ok(r.sink.events.some((e) => e.type === "notice" && /still points to its planning session/.test(e.text)));
    const stored = r.provider.store.read("thread");
    assert.equal(stored.session, r.handle.id);
    assert.equal(stored.previousSession, undefined);
    assert.equal(stored.mode, "plan", "an unconfirmed replacement must not grant implementation in the source");
    assert.equal(r.sdk.opens.length, 1, "no speculative target is opened");
  });
}

test("a restart between saving a Spec successor ID and reopening it resumes the target without replaying the plan", async (t) => {
  const r = await rig(t), held = gate();
  await r.session.setMode("plan");
  r.sdk.contexts.set("implementation", r.handle.cwd);
  r.sink.answer = async () => ({ kind: "approval.option", option: "proceed_new_session_low" });
  r.handle.script = async function* (handle) {
    await handle.options.permissionHandler!(specPermission());
    handoffNotifications(handle, "implementation");
    await held.promise;
    yield result(handle.id);
  };
  r.session.startTurn({ text: "plan once", images: [] });
  await until(() => r.provider.store.read("thread").session === "implementation");
  assert.equal(r.sdk.opens.length, 1);
  await r.session.close();
  held.resolve();
  const sink = new Sink();
  const resumed = await r.provider.resumeSession(r.options(), sink);
  assert.equal(r.sdk.opens.length, 1);
  await turn(resumed, sink, "continue implementation");
  assert.equal(r.sdk.opens.at(-1)?.id, "implementation");
  assert.deepEqual(r.sdk.handles.at(-1)!.prompts.map((p) => p.text), ["continue implementation"]);
  assert.equal((await resumed.history()).filter((m) => m.role === "user" && m.text === "plan once").length, 1);
});

test("a failed Spec successor mapping write keeps the source; a failed target open keeps the saved target", async (t) => {
  for (const fail of ["write", "open"] as const) {
    const r = await rig(t);
    await r.session.setMode("plan");
    r.sdk.contexts.set("implementation", r.handle.cwd);
    r.sink.answer = async () => ({ kind: "approval.option", option: "proceed_new_session_low" });
    const write = r.provider.store.write.bind(r.provider.store);
    r.provider.store.write = (state) => {
      if (fail === "write" && state.session === "implementation") throw new Error("disk unavailable");
      write(state);
    };
    const open = r.sdk.open.bind(r.sdk);
    r.sdk.open = async (options, id) => {
      if (fail === "open" && id === "implementation") throw new Error("target cannot load");
      return open(options, id);
    };
    r.handle.script = async function* (handle) {
      await handle.options.permissionHandler!(specPermission());
      handoffNotifications(handle, "implementation");
      yield result(handle.id);
    };
    assert.equal((await turn(r.session, r.sink, "plan")).status, "error");
    const stored = r.provider.store.read("thread");
    assert.equal(stored.session, fail === "write" ? r.handle.id : "implementation");
    assert.equal(stored.previousSession, fail === "write" ? undefined : r.handle.id);
    assert.equal(stored.mode, fail === "write" ? "plan" : "edits");
    assert.equal(r.handle.closed, 1);
  }
});

test("rich approval wire validation never turns malformed option answers into permission", async (t) => {
  const r = await rig(t);
  await r.session.close();
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const { session_id } = await client.call("session.create", { profile: "droid" });
  await client.call("session.set_mode", { session_id, mode: "plan" });
  const handle = r.sdk.handles.at(-1)!;
  let response: unknown;
  handle.script = async function* (h) { response = await h.options.permissionHandler!(specPermission()); yield result(h.id); };
  for (const answer of [
    { option: "unknown" }, { option: "proceed_auto_run_high" }, { choice: "once", option: "proceed_once" },
    { option: "proceed_edit" }, { option: "proceed_edit", edited_plan: "  " },
    { option: "proceed_edit", edited_plan: "Revised Markdown\n", note: "Keep planning." },
  ]) {
    const mark = client.frames.length;
    await client.call("prompt.submit", { session_id, text: "plan" });
    const card = await client.from(mark, (f) => f.method === "approval");
    assert.equal(card.params.plan_content, "Reply done.");
    assert.deepEqual(card.params.choices, ["once", "deny"]);
    assert.equal(card.params.options.find((o: { id: string }) => o.id === "proceed_new_session_low").requires_confirmation, true);
    assert.deepEqual(card.params.details, [{ tool_id: "spec-call", name: "ExitSpecMode", type: "exit_spec_mode" }]);
    client.answer(card.id, answer);
    await client.from(mark, (f) => f.params?.type === "message.complete");
    assert.deepEqual(response, typeof answer.edited_plan === "string" && answer.edited_plan.trim()
      ? { selectedOption: "proceed_edit", editedSpecContent: "Revised Markdown\n", comment: "Keep planning." }
      : { selectedOption: "cancel" });
    assert.equal((await client.call("session.resume", { session_id })).info.mode, "plan");
  }
});

test("an SDK permission settlement closes the matching card on every follower and ignores late answers", async (t) => {
  const r = await rig(t), completed = gate();
  await r.session.close();
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const a = await TestClient.open(bridge), b = await TestClient.open(bridge);
  t.after(async () => { await a.close(); await b.close(); });
  const { session_id } = await a.call("session.create", { profile: "droid" });
  await b.call("session.resume", { session_id });
  const handle = r.sdk.handles.at(-1)!;
  let response: unknown;
  handle.script = async function* (h) {
    response = await h.options.permissionHandler!(specPermission());
    await completed.promise;
    yield result(h.id);
  };
  await a.call("prompt.submit", { session_id, text: "plan" });
  const first = await a.nextRequest(), second = await b.nextRequest();
  assert.equal(first.id, second.id);
  handle.notify({ params: { notification: { type: "permission_resolved", toolUseIds: ["spec-call"], selectedOption: "cancel" } } });
  for (const client of [a, b]) {
    const cancel = await client.nextEvent("request.cancel", session_id);
    assert.equal(cancel.payload.id, first.id);
    assert.equal(cancel.payload.reason, "resolved");
    client.answer(first.id, { option: "proceed_new_session_low" });
  }
  await until(() => response !== undefined);
  assert.deepEqual(response, { selectedOption: "cancel" });
  assert.deepEqual((await a.call("session.resume", { session_id })).open_requests, []);
  completed.resolve();
  await a.nextEvent("message.complete", session_id);
});

test("Droid sends images by content type and preserves the existing file-path prompt", async (t) => {
  const r = await rig(t);
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await turn(r.session, r.sink, { text: "Read /tmp/example.txt", files: ["/tmp/example.txt"],
    images: [{ filename: "../../wrong.jpg", data }, { filename: "no.heic", data: Buffer.from("unsupported") }] });
  assert.equal(r.handle.prompts[0].text, "Read /tmp/example.txt");
  assert.deepEqual(r.handle.prompts[0].options?.images, [{ type: "base64", mediaType: "image/png", data: data.toString("base64") }]);
  assert.ok(r.sink.events.some((event) => event.type === "notice" && /image was left out/.test(event.text)));
});

test("settings are session-only, validate models and reasoning, and defer mid-turn changes", async (t) => {
  const r = await rig(t);
  await assert.rejects(r.session.setModel("missing", "droid"), SettingRefused);
  await assert.rejects(r.session.setModel("large", "other"), SettingRefused);
  await assert.rejects(r.session.setReasoning("ultra"), SettingRefused);
  await r.session.setMode("edits");
  assert.equal(r.handle.settings.autonomyLevel, "low");
  await r.session.setMode("full");
  assert.equal(r.handle.settings.autonomyLevel, "high");
  await r.session.setMode("ask");
  const waiting = gate();
  r.handle.script = async function* (handle) { await waiting.promise; yield result(handle.id); };
  r.session.startTurn({ text: "wait", images: [] });
  await until(() => r.handle.prompts.length === 1);
  assert.deepEqual(await r.session.setModel("large", "droid"), { deferred: true });
  await r.session.setReasoning("high");
  assert.equal(r.handle.settings.modelId, "small");
  waiting.resolve();
  await r.sink.end();
  r.handle.script = null;
  await turn(r.session, r.sink, "next");
  assert.equal(r.handle.settings.modelId, "large");
  assert.equal(r.handle.settings.reasoningEffort, "high");
  await r.session.setModel("default", "droid");
  assert.equal(r.handle.settings.modelId, "small");
});

test("Spec mode plans with the thread's own model and thinking level, changed in the normal picker", async (t) => {
  const r = await rig(t);
  await r.session.setMode("plan");
  assert.equal(r.handle.settings.specModeModelId, "small");
  assert.equal(r.handle.settings.specModeReasoningEffort, "off", "the thread's effort, not the model's default (low)");
  await r.session.setModel("large", "droid");
  assert.equal(r.handle.settings.specModeModelId, "large");
  assert.equal(r.handle.settings.specModeReasoningEffort, "low", "a new model's default effort, as the thread's");
  await r.session.setReasoning("high");
  assert.equal(r.handle.settings.specModeReasoningEffort, "high");
  const waiting = gate();
  r.handle.script = async function* (handle) { await waiting.promise; yield result(handle.id); };
  r.session.startTurn({ text: "wait", images: [] });
  await until(() => r.handle.prompts.length === 1);
  assert.deepEqual(await r.session.setModel("small", "droid"), { deferred: true });
  assert.equal(r.handle.settings.specModeModelId, "large", "deferred while busy, as the normal model is");
  waiting.resolve();
  await r.sink.end();
  r.handle.script = null;
  await turn(r.session, r.sink, "next");
  assert.equal(r.handle.settings.modelId, "small");
  assert.equal(r.handle.settings.specModeModelId, "small");
  assert.equal(r.handle.settings.specModeReasoningEffort, "low");
  assert.equal("specModel" in r.session.settings(), false);
});

test("a Spec model saved on a thread before is dropped: Spec mode follows the thread's model and effort", async (t) => {
  const r = await rig(t);
  await turn(r.session, r.sink, "first");
  await r.session.close();
  const saved = r.provider.store.read("thread");
  r.provider.store.write({ ...saved, settings: { ...saved.settings, specModel: "large", specReasoningEffort: "high" } } as typeof saved);
  const sink = new Sink(), resumed = await r.provider.resumeSession(r.options(), sink);
  assert.deepEqual(resumed.settings(), { model: "small", provider: "droid", reasoningEffort: "none" });
  assert.equal((await turn(resumed, sink, "again")).status, "complete");
  assert.equal(r.sdk.handles.at(-1)!.settings.specModeModelId, "small");
  assert.equal(r.sdk.handles.at(-1)!.settings.specModeReasoningEffort, "off");
  assert.equal("specModel" in r.provider.store.read("thread").settings, false, "saved again without it");
});

test("session.set_spec_model from an older app changes nothing, and session info no longer offers a Spec model", async (t) => {
  const r = await rig(t);
  await r.session.close();
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const created = await client.call("session.create", { profile: "droid" });
  const session_id = created.session_id;
  assert.equal("spec_model" in created.info, false);
  assert.equal("spec_reasoning_effort" in created.info, false);
  assert.deepEqual(await client.call("session.set_spec_model", { session_id, model: "large", reasoning_effort: "high" }),
    { spec_model: "default", spec_reasoning_effort: "", deferred: false });
  const info = (await client.call("session.resume", { session_id })).info;
  assert.equal("spec_model" in info, false);
  assert.equal(info.model, "small");
  await assert.rejects(client.call("session.set_spec_model", { session_id: "missing", model: "large" }));
});

test("stop withdraws an unanswered question, ends once, and preserves the resumable session", async (t) => {
  const r = await rig(t);
  r.sink.answer = async (_request, signal) => new Promise((resolve) => {
    signal!.addEventListener("abort", () => resolve({ kind: "withdrawn", reason: "Stopped." }), { once: true });
  });
  let answer: unknown;
  r.handle.script = async function* (handle) {
    answer = await handle.options.askUserHandler!({ toolCallId: "question", questions: [{ index: 1, topic: "Color", question: "Which?", options: ["red", "blue"] }] });
    yield result(handle.id, handle.interrupted);
  };
  r.session.startTurn({ text: "question", images: [] });
  await until(() => r.sink.requests.length === 1);
  r.provider.pool.sweep(Date.now() + 5000);
  assert.equal(r.handle.closed, 0);
  assert.equal(await r.session.interrupt(), true);
  assert.equal((await r.sink.end())[0].status, "interrupted");
  assert.deepEqual(answer, { cancelled: true, answers: [] });
  assert.equal(r.sink.events.filter((event) => event.type === "turn.end").length, 1);
  assert.equal(await r.session.interrupt(), false);
});

test("a turn stopped with Stop is kept as every agent's stop is, an interrupted reply, so it reads back stopped, not failed with Try again (D4)", async (t) => {
  const r = await rig(t);
  const stopped = gate();
  r.handle.script = async function* (handle) {
    yield { type: "assistant_text_delta", messageId: "m", blockIndex: 0, text: "Counting: 1, 2" };
    await stopped.promise;
    yield result(handle.id, true);
  };
  const mark = r.sink.events.length;
  r.session.startTurn({ text: "count", images: [] });
  await until(() => r.sink.events.slice(mark).some((event) => event.type === "text"));
  assert.equal(await r.session.interrupt(), true);
  stopped.resolve();
  assert.equal((await r.sink.end(mark))[0].status, "interrupted");
  const kept = r.provider.store.read("thread").messages;
  // The shared transcript's mark (sessions/transcript.ts): no failed turn's line, which the app reads first.
  assert.deepEqual(kept.slice(-3).map((message) => ({ ...message, timestamp: 0 })), [
    { role: "user", text: "count", timestamp: 0 },
    { role: "assistant", text: "Counting: 1, 2", timestamp: 0 },
    { role: "assistant", text: "", timestamp: 0, display_metadata: { interrupted: true }, turn_usage: { seconds: 0.001 } },
  ]);
  assert.equal(kept.some((message) => message.role === "assistant" && message.display_kind === "failed_turn"), false);
  // A turn the bridge stopped under (a crash) is still told as failed, with Droid's line (recovery-8).
  r.provider.store.write({ ...r.provider.store.read("thread"), open: true });
  await r.session.close();
  const reopened = await r.provider.resumeSession(r.options(), new Sink());
  const last = (await reopened.history()).at(-1)!;
  assert.equal(last.role === "assistant" && last.display_kind, "failed_turn");
});

test("Droid's pick list during a turn asks on the turn's question card and answers with the rows picked; at rest it is cancelled (n14, SDK 0.10.0)", async (t) => {
  const r = await rig(t);
  const params = { toolCallId: "pick-1", title: "Channels", rows: [{ id: "C1", label: "general" }, { id: "C2", label: "dev" }], multi: false, preselectedIds: [] };
  assert.deepEqual(await r.handle.picker!(params), { cancelled: true, selectedIds: [] }, "no turn to ask in");
  r.sink.answer = async () => ({ kind: "clarify", answers: { pick: "dev" } });
  let picked: unknown;
  r.handle.script = async function* (handle) {
    picked = await handle.picker!(params);
    yield result(handle.id);
  };
  await turn(r.session, r.sink, "pick a channel");
  assert.deepEqual(picked, { selectedIds: ["C2"] });
  assert.deepEqual(r.sink.requests.at(-1), { kind: "clarify", requiresAllAnswers: true, questions: [{ qid: "pick", question: "Channels", choices: ["general", "dev"], multiSelect: false }] });
});

test("stop force-closes a stuck process and ignores its late events", async (t) => {
  const r = await rig(t);
  const waiting = gate();
  t.after(() => waiting.resolve());
  r.handle.script = async function* (handle) {
    await waiting.promise;
    yield { type: "assistant_text_delta", messageId: "late", blockIndex: 0, text: "must not appear" };
    yield result(handle.id);
  };
  r.session.startTurn({ text: "wait", images: [] });
  await until(() => r.handle.prompts.length === 1);
  await r.session.interrupt();
  assert.equal((await r.sink.end())[0].status, "interrupted");
  await turn(r.session, r.sink, "next");
  waiting.resolve();
  await sleep(5);
  assert.equal(r.sink.events.filter((event) => event.type === "turn.end").length, 2);
  assert.ok(!r.sink.events.some((event) => event.type === "text" && event.text.includes("must not appear")));
});

test("a late failed Stop reply cannot close Droid while the next turn is running", async (t) => {
  const r = await rig(t, { interruptGraceMs: 60_000 });
  const stopped = gate(), reply = gate(), second = gate();
  t.after(() => { stopped.resolve(); reply.resolve(); second.resolve(); });
  r.handle.interrupt = async () => { await reply.promise; throw new Error("That turn already ended."); };
  r.handle.script = async function* (handle) { await stopped.promise; yield result(handle.id, true); };
  r.session.startTurn({ text: "stop this", images: [] });
  await until(() => r.handle.prompts.length === 1);
  await r.session.interrupt();
  stopped.resolve();
  assert.equal((await r.sink.end())[0].status, "interrupted");
  r.handle.script = async function* (handle) { await second.promise; yield result(handle.id); };
  const mark = r.sink.events.length;
  r.session.startTurn({ text: "keep this running", images: [] });
  await until(() => r.handle.prompts.length === 2);
  reply.resolve();
  await sleep(0);
  assert.equal(r.handle.closed, 0, "the failed interrupt belongs to the ended turn");
  second.resolve();
  assert.equal((await r.sink.end(mark))[0].status, "complete");
});

test("process death produces one terminal failure, then resumes the saved session", async (t) => {
  const r = await rig(t);
  const waiting = gate();
  t.after(() => waiting.resolve());
  r.handle.script = async function* () { await waiting.promise; throw new Error("transport closed"); };
  r.session.startTurn({ text: "working", images: [] });
  await until(() => r.handle.prompts.length === 1);
  r.handle.die();
  assert.equal((await r.sink.end())[0].status, "error");
  await turn(r.session, r.sink, "retry");
  waiting.resolve();
  await sleep(5);
  assert.equal(r.sink.events.filter((event) => event.type === "turn.end").length, 2);
  assert.equal(r.sdk.opens.at(-1)?.id, r.handle.id);
  assert.equal(r.sdk.handles.at(-1)?.alive, true, "the old stream cannot close the replacement handle");
});

test("two active threads keep their handles, events, settings and context separate", async (t) => {
  const r = await rig(t);
  const sink = new Sink();
  const second = await r.provider.startSession(r.options("second"), sink);
  await second.setModel("large", "droid");
  await Promise.all([turn(r.session, r.sink, "first secret"), turn(second, sink, "second secret")]);
  assert.equal(r.sdk.handles.length, 2);
  assert.notEqual(r.sdk.handles[0].id, r.sdk.handles[1].id);
  assert.equal(r.handle.settings.modelId, "small");
  assert.equal(r.sdk.handles[1].settings.modelId, "large");
  assert.ok(!r.sink.events.some((event) => event.type === "text" && event.text.includes("second secret")));
  assert.ok(!sink.events.some((event) => event.type === "text" && event.text.includes("first secret")));
});

test("Droid trailing idle after agent completion clears busy state and permits cooling", async (t) => {
  const r = await rig(t);
  await turn(r.session, r.sink, "reply");
  for (const notification of [
    { type: "droid_working_state_changed", newState: "streaming_assistant_message" },
    { type: "agent_turn_completed", reason: "completed" },
    { type: "droid_working_state_changed", newState: "idle" },
  ]) r.handle.notify({ params: { sessionId: r.handle.id, notification } });
  assert.equal(r.session.busy, false);
  assert.equal(r.session.hasBackgroundWork(), false);
  await r.session.cool();
  assert.equal(r.handle.closed, 1);
});

test("interrupting a bound awaited Task stops its tracking and lets the process cool", async (t) => {
  const r = await rig(t);
  r.handle.script = async function* (h) {
    yield { type: "tool_call", name: "Task", toolUseId: "awaited", input: { await: true } };
    h.notify({ params: { sessionId: h.id, notification: { type: "child_session_available", toolUseId: "awaited", childSessionId: "child" } } });
    await until(() => h.interrupted);
    yield result(h.id, true);
  };
  r.session.startTurn({ text: "inspect", images: [] });
  await until(() => r.provider.store.read("thread").subagents?.length === 1 || r.sink.events.some((e) => e.type === "subagent"));
  await r.session.interrupt();
  assert.equal((await r.sink.end())[0].status, "interrupted");
  assert.equal(r.provider.store.read("thread").subagents![0].status, "stopped");
  assert.match(r.provider.store.read("thread").subagents![0].result!, /interrupted/);
  assert.equal(r.session.busy, false);
  await r.session.cool();
  assert.equal(r.handle.closed, 1);
});

test("background work pins its process, while idle sessions can cool", async (t) => {
  const r = await rig(t);
  r.handle.script = async function* (handle) {
    yield { type: "tool_call", name: "Execute", toolUseId: "background", input: { command: "background task", fireAndForget: true } };
    yield { type: "tool_result", toolName: "Execute", toolUseId: "background", content: "Background process started (PID: 12)", isError: false };
    yield result(handle.id);
  };
  await turn(r.session, r.sink, "background");
  assert.equal(r.session.hasBackgroundWork(), true);
  await r.session.cool();
  r.provider.pool.sweep(Date.now() + 5000);
  assert.equal(r.handle.closed, 0);
  r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "create_message", message: {
    id: "execute-completion:background", role: "user", visibility: "llm_only",
    content: [{ type: "text", text: "Background Execute command finished.\ntool_use_id: background\nexit_status: code 0\noutput: done" }],
  } } } });
  assert.equal(r.session.hasBackgroundWork(), true, "protect the automatic parent follow-up until its completion too");
  r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "agent_turn_completed", reason: "completed" } } });
  assert.equal(r.session.hasBackgroundWork(), false);
  assert.equal(r.session.busy, false);
  const history = await r.session.history();
  const row = history.find((message) => message.role === "tool" && message.tool_call_id.startsWith("background#bg-"));
  assert.ok(row?.role === "tool");
  assert.deepEqual(JSON.parse(row.content!), { output: "done", exit_code: 0 });
  // Idle time counts from the last sweep that found it busy.
  r.provider.pool.sweep(Date.now() + 10_000);
  await until(() => r.handle.closed === 1);
});

test("a Script Droid runs on in the background pins its process until its completion, as a background command does: closing the process stops it and loses its result (Codex's review of n14/droid, P1)", async (t) => {
  const r = await rig(t);
  // CLI 0.250: a Script still running as its call returns answers {toolCallId, status: "running"}.
  const running = (id: string) => ({ type: "tool_result" as const, toolName: "Script", toolUseId: id, content: JSON.stringify({ toolCallId: id, status: "running" }), isError: false });
  r.handle.script = async function* (handle) {
    yield { type: "tool_call", name: "Script", toolUseId: "script-1", input: { code: "await Execute({ command: 'npm test' })" } };
    yield running("script-1");
    yield { type: "tool_call", name: "Script", toolUseId: "script-2", input: { code: "await Read({ file_path: 'a' })" } };
    yield { type: "tool_result", toolName: "Script", toolUseId: "script-2", content: "[Script completed · 0.4 s elapsed · 1 call · no log]", isError: false };
    yield result(handle.id);
  };
  await turn(r.session, r.sink, "run the tests in a script");
  assert.equal(r.session.hasBackgroundWork(), true);
  await r.session.cool();
  r.provider.pool.sweep(Date.now() + 5000);
  assert.equal(r.handle.closed, 0, "a running Script holds its process");
  // Its completion: a turn Droid delivers under `script-completion:<parent session>:<run id>:<tool use id>`.
  const id = `script-completion:${r.handle.id}:run-1:script-1`;
  tell(r.handle, { type: "create_message", message: { id, role: "user", content: [{ type: "text", text: "Script run-1 completed." }] } });
  tell(r.handle, { type: "agent_turn_completed", reason: "completed", turnId: id, tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
  assert.equal(r.session.hasBackgroundWork(), false);
  r.provider.pool.sweep(Date.now() + 10_000);
  await until(() => r.handle.closed === 1);

  // A batch (`script-completion-batch:`) tells of Script runs that ended while the session was
  // not loaded (CLI 0.250), none of this process's: the two at work stay held, each to its own end.
  const open = r.sdk.open.bind(r.sdk);
  r.sdk.open = async (...args: Parameters<Sdk["open"]>) => {
    const handle = await open(...args);
    handle.script = async function* (h) {
      yield { type: "tool_call", name: "Script", toolUseId: "script-3", input: {} };
      yield running("script-3");
      yield { type: "tool_call", name: "Script", toolUseId: "script-4", input: {} };
      yield running("script-4");
      yield result(h.id);
    };
    return handle;
  };
  await turn(r.session, r.sink, "two scripts");
  const h = () => r.sdk.handles.at(-1)!;
  assert.notEqual(h(), r.handle);
  assert.equal(r.session.hasBackgroundWork(), true);
  const batch = `script-completion-batch:${h().id}:0123456789abcdef`;
  tell(h(), { type: "create_message", message: { id: batch, role: "user", content: [{ type: "text", text: "2 Script runs reached a terminal state while this session was not loaded.\n- {\"toolCallId\":\"script-3\",\"status\":\"completed\"}\n- {\"toolCallId\":\"script-30\",\"status\":\"failed\"}" }] } });
  tell(h(), { type: "agent_turn_completed", reason: "completed", turnId: batch, tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
  assert.equal(r.session.hasBackgroundWork(), true, "a batch ends none of this process's Scripts");
  const ended = (id: string) => {
    const completion = `script-completion:${h().id}:run-${id}:${id}`;
    tell(h(), { type: "create_message", message: { id: completion, role: "user", content: [{ type: "text", text: "done" }] } });
    tell(h(), { type: "agent_turn_completed", reason: "completed", turnId: completion, tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
  };
  ended("script-4");
  assert.equal(r.session.hasBackgroundWork(), true, "script-3 still runs: the batch that names it is not its end");
  ended("script-3");
  assert.equal(r.session.hasBackgroundWork(), false);
});

test("a Script is held by what Droid's last text says of it, not by what it printed, and a later Script under an ended one's id is held too (a model that numbers its calls afresh; Codex's re-check, P1, P2)", async (t) => {
  const r = await rig(t);
  const running = (id: string) => ({ type: "tool_result" as const, toolName: "Script", toolUseId: id, content: JSON.stringify({ toolCallId: id, status: "running" }), isError: false });
  // It printed a status of its own, then ended in the call: Droid's last text says completed.
  r.handle.script = async function* (handle) {
    yield { type: "tool_call", name: "Script", toolUseId: "call_0", input: {} };
    yield { type: "tool_result", toolName: "Script", toolUseId: "call_0", isError: false,
      content: [{ type: "text", text: '{"status":"running"}' }, { type: "text", text: "[Script completed · 0.2 s elapsed · 1 call · no log]" }] } as unknown as DroidStreamEvent;
    yield result(handle.id);
  };
  await turn(r.session, r.sink, "print a status");
  assert.equal(r.session.hasBackgroundWork(), false);
  // call_0 again, now run on in the background, ended; then call_0 a third time, at work.
  for (const turnText of ["background", "again"]) {
    r.handle.script = async function* (handle) {
      yield { type: "tool_call", name: "Script", toolUseId: "call_0", input: {} };
      yield running("call_0");
      yield result(handle.id);
    };
    await turn(r.session, r.sink, turnText);
    assert.equal(r.session.hasBackgroundWork(), true, `${turnText}: held`);
    if (turnText === "background") {
      const completion = `script-completion:${r.handle.id}:call_0:call_0`;
      tell(r.handle, { type: "create_message", message: { id: completion, role: "user", content: [{ type: "text", text: "done" }] } });
      tell(r.handle, { type: "agent_turn_completed", reason: "completed", turnId: completion, tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
      assert.equal(r.session.hasBackgroundWork(), false);
    }
  }
  r.provider.pool.sweep(Date.now() + 5000);
  assert.equal(r.handle.closed, 0, "the third Script holds its process");
  // Its completion has the same id as the second's (CLI 0.250's run id is the call's), and is its own.
  const completion = `script-completion:${r.handle.id}:call_0:call_0`;
  for (let n = 0; n < 2; n++) {
    tell(r.handle, { type: "create_message", message: { id: completion, role: "user", content: [{ type: "text", text: "done" }] } });
    tell(r.handle, { type: "agent_turn_completed", reason: "completed", turnId: completion, tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
    if (n === 0) assert.equal(r.session.hasBackgroundWork(), false);
  }
});

test("the end of Droid's turn for Scripts that ended together (script-completion-batch:…), heard during a turn of Droid's own, does not end that turn", async (t) => {
  const r = await rig(t);
  await turn(r.session, r.sink, "hello");
  const mark = r.sink.events.length;
  tell(r.handle, { type: "droid_working_state_changed", newState: "streaming_assistant_message" });
  tell(r.handle, { type: "assistant_text_delta", messageId: "own", blockIndex: 0, textDelta: "Still on it" });
  assert.equal(r.sink.events.slice(mark).filter((event) => event.type === "turn.begin").length, 1);
  const batch = `script-completion-batch:${r.handle.id}:0123456789abcdef`;
  tell(r.handle, { type: "create_message", message: { id: batch, role: "user", content: [{ type: "text", text: "Scripts ended." }] } });
  tell(r.handle, { type: "agent_turn_completed", reason: "completed", turnId: batch, tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
  assert.deepEqual(r.sink.events.slice(mark).filter((event) => event.type === "turn.end"), [], "its end is the batch's turn's, not this one's");
  tell(r.handle, { type: "agent_turn_completed", reason: "completed", turnId: "own-turn", tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
  assert.deepEqual(r.sink.events.slice(mark).filter((event) => event.type === "turn.end").map((event) => event.type === "turn.end" && event.status), ["complete"]);
});

test("a background command's id is its own: a late final result goes to its row though a newer call reused Droid's id, and two such commands stay two rows", async (t) => {
  const r = await rig(t);
  const launch = (command: string) => async function* (handle: Handle): AsyncGenerator<DroidStreamEvent> {
    // A model that numbers its calls afresh in each answer.
    yield { type: "tool_call", name: "Execute", toolUseId: "call_0", input: { command, fireAndForget: true } };
    yield { type: "tool_result", toolName: "Execute", toolUseId: "call_0", content: "Background process started (PID: 12)", isError: false };
    yield result(handle.id);
  };
  r.handle.script = launch("npm test");
  await turn(r.session, r.sink, "run the tests in the background");
  // The next answer's first call has the same id, and runs in the foreground.
  r.handle.script = async function* (handle) {
    yield { type: "tool_call", name: "Execute", toolUseId: "call_0", input: { command: "git status" } };
    yield { type: "tool_result", toolName: "Execute", toolUseId: "call_0", content: "clean\nexit code: 0", isError: false };
    yield result(handle.id);
  };
  await turn(r.session, r.sink, "and the status");
  const mark = r.sink.events.length;
  r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "create_message", message: {
    id: "execute-completion:call_0", role: "user", visibility: "llm_only",
    content: [{ type: "text", text: "Background Execute command finished.\ntool_use_id: call_0\nexit_status: code 0\noutput: 12 passed" }],
  } } } });
  const starts = r.sink.events.flatMap((event) => (event.type === "tool.start" ? [event.id] : []));
  assert.equal(starts.length, 2);
  assert.match(starts[0]!, /^call_0#bg-/);
  assert.equal(starts[1], "call_0");
  const late = r.sink.events.slice(mark).filter((event) => event.type === "tool.end");
  assert.deepEqual(late.map((event) => event.id), [starts[0]]);
  const rows = (await r.session.history()).flatMap((message) => (message.role === "tool" ? [message] : []));
  assert.deepEqual(rows.map((row) => [row.tool_call_id, JSON.parse(row.content!).output]), [[starts[0], "12 passed"], ["call_0", "clean\nexit code: 0"]]);

  // The same command in the background again, with the same id: a row of its own.
  r.handle.script = launch("npm test");
  await turn(r.session, r.sink, "run them again");
  const ids = (await r.session.history()).flatMap((message) => (message.role === "tool" ? [message.tool_call_id] : []));
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  assert.match(ids[2]!, /^call_0#bg-/);
  assert.deepEqual(r.provider.store.read("thread").nativeToolIds, { [ids[0]]: "call_0", [ids[2]]: "call_0" });
});

for (const fast of [false, true]) test(`gateway resume keeps one final background Execute row when completion ${fast ? "beats" : "follows"} the launch result`, async (t) => {
  const r = await rig(t);
  await r.session.close();
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const { session_id } = await client.call("session.create", { profile: "droid" });
  const h = r.sdk.handles.at(-1)!;
  const finish = () => h.notify({ params: { sessionId: h.id, notification: { type: "create_message", message: {
    id: "execute-completion:background", role: "user", visibility: "llm_only",
    content: [{ type: "text", text: "Background Execute command finished.\ntool_use_id: background\nexit_status: code 0\noutput: FINAL_OUTPUT" }],
  } } } });
  h.script = async function* (handle) {
    yield { type: "tool_call", name: "Execute", toolUseId: "background", input: { command: "run", summary: "Background check", fireAndForget: true } };
    if (fast) finish();
    yield { type: "tool_result", toolName: "Execute", toolUseId: "background", content: "Background process started (PID: 12)", isError: false };
    yield result(handle.id);
  };
  await client.call("prompt.submit", { session_id, text: "background" });
  await client.nextEvent("message.complete", session_id);
  if (!fast) finish();
  h.notify({ params: { sessionId: h.id, notification: { type: "agent_turn_completed" } } });
  const resumed = await client.call("session.resume", { session_id });
  const rows = resumed.messages.filter((m: any) => m.role === "tool" && m.tool_call_id.startsWith("background#bg-"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].args.summary, "Background check");
  assert.deepEqual(JSON.parse(rows[0].content), { output: "FINAL_OUTPUT", exit_code: 0 });
});

test("Droid background Tasks persist actual child snapshots and finish on trusted reports before the tracking bound", async (t) => {
  const r = await rig(t);
  r.handle.script = async function* (handle) {
    yield { type: "tool_call", name: "Task", toolUseId: "task", input: { await: false, description: "Background check", subagent_type: "explorer" } };
    handle.notify({ params: { sessionId: handle.id, notification: { type: "child_session_available", toolUseId: "task", childSessionId: "child" } } });
    yield { type: "tool_result", toolUseId: "task", toolName: "Task", content: "Task launched in background.\ntask_id: child\nsession_id: child\nsubagent_type: explorer", isError: false };
    yield result(handle.id);
  };
  await turn(r.session, r.sink, "launch task");
  r.provider.pool.sweep(Date.now() + 5000);
  assert.equal(r.handle.closed, 0, "elapsed time never guesses that a live task ended");
  const pending = r.provider.store.read("thread").subagents!;
  assert.equal(pending[0].status, "running");
  const message = { id: "task-completion:notification", role: "system", visibility: "llm_only",
    content: [{ type: "text", text: "Background task completed.\ntask_id: child\ntype: explorer\nreason: completed\ndescription: Background check\noutput: Final child report" }] };
  r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "agent_turn_completed", reason: "completed" } } });
  r.handle.notify({ params: { sessionId: "other", notification: { type: "create_message", message } } });
  assert.equal(r.session.hasBackgroundWork(), true);
  r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "create_message", message } } });
  assert.equal(r.provider.store.read("thread").subagents![0].result, "Final child report");
  assert.equal(r.session.busy, true, "automatic parent follow-up still owns the process");
  r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "agent_turn_completed", reason: "completed" } } });
  assert.equal(r.session.busy, false);
  await r.session.close();
  const sink = new Sink(), before = r.sdk.opens.length;
  const resumed = await r.provider.resumeSession(r.options(), sink);
  resumed.attached();
  assert.equal(r.sdk.opens.length, before);
  assert.ok(sink.events.some((event) => event.type === "subagent" && event.subagent.id === "child"
    && event.subagent.status === "completed" && event.subagent.result === "Final child report"));
  await resumed.close();
  const saved = r.provider.store.read("thread");
  r.provider.store.write({ ...saved, subagents: pending });
  const restarted = await r.provider.resumeSession(r.options(), new Sink());
  assert.equal(r.provider.store.read("thread").subagents![0].status, "stopped");
  assert.match(r.provider.store.read("thread").subagents![0].result!, /did not report a terminal outcome/);
  assert.equal(restarted.hasBackgroundWork(), false, "restart does not invent a surviving process or replay a Task");
});

test("background thread removal is refused before the lease expires and succeeds afterward for Task and Execute", async (t) => {
  for (const name of ["Task", "Execute"]) {
    let now = 0;
    const r = await rig(t, { backgroundHoldMs: 1000, now: () => now });
    await r.session.close();
    const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
    t.after(() => bridge.dispose());
    const client = await TestClient.open(bridge);
    t.after(() => client.close());
    const { session_id } = await client.call("session.create", { profile: "droid" });
    const h = r.sdk.handles.at(-1)!;
    h.script = async function* (handle) {
      yield { type: "tool_call", name, toolUseId: "job", input: name === "Task" ? { await: false } : { fireAndForget: true } };
      if (name === "Task") handle.notify({ params: { sessionId: handle.id, notification: { type: "child_session_available", toolUseId: "job", childSessionId: "child" } } });
      yield { type: "tool_result", toolUseId: "job", toolName: name, isError: false, content: name === "Task"
        ? "Task launched in background.\nsession_id: child\nsubagent_type: explorer" : "Background process started (PID: 1)" };
      yield result(handle.id);
    };
    await client.call("prompt.submit", { session_id, text: "launch" });
    await client.nextEvent("message.complete", session_id);
    await assert.rejects(client.call("thread.delete", { thread: session_id }), /still has work running in the background/);
    now = 1000;
    await client.call("thread.delete", { thread: session_id });
    await until(() => h.closed === 1);
    if (name === "Task") assert.equal(r.provider.store.read(session_id).subagents![0].status, "stopped");
  }
});

test("Droid actual child identity, nested progress and final report use existing gateway subagent events with no stop claim", async (t) => {
  const r = await rig(t);
  await r.session.close();
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const { session_id } = await client.call("session.create", { profile: "droid" });
  const handle = r.sdk.handles.at(-1)!;
  handle.script = async function* (h) {
    yield { type: "tool_call", toolUseId: "task", name: "Task", input: { await: true, description: "Inspect", subagent_type: "explorer" } };
    h.notify({ params: { sessionId: h.id, notification: { type: "child_session_available", toolUseId: "task", childSessionId: "sdk-child" } } });
    h.notify({ params: { sessionId: h.id, notification: { type: "tool_progress_update", toolUseId: "task",
      update: { type: "tool_call", toolName: "Execute", subagentSessionId: "sdk-child", details: "Running a check" } } } });
    yield { type: "tool_result", toolUseId: "task", toolName: "Task", content: "session_id: sdk-child\nChild's final report", isError: false };
    yield result(h.id);
  };
  await client.call("prompt.submit", { session_id, text: "inspect" });
  await client.nextEvent("message.complete", session_id);
  const events = client.events(session_id);
  assert.equal(events.find((event) => event.type === "subagent.start")?.payload.subagent_id, "sdk-child");
  assert.ok(events.some((event) => event.type === "subagent.progress" && event.payload.tool_name === "terminal" && event.payload.summary === "Running a check"));
  const completed = events.find((event) => event.type === "subagent.complete")!.payload;
  assert.equal(completed.result, "Child's final report");
  assert.equal(completed.can_stop, false);
  assert.equal(completed.background, false);
  assert.equal((await client.call("subagent.list", { session_id })).subagents[0].subagent_id, "sdk-child");
  assert.deepEqual(await client.call("subagent.stop", { session_id, subagent_id: "sdk-child" }), { status: "not_running" });
  assert.equal(events.filter((event) => event.type === "tool.start").length, 1, "nested tool updates do not become main transcript rows");
});

test("Droid works through the existing gateway, including queued messages and restart history", async (t) => {
  const r = await rig(t);
  await r.session.close();
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const created = await client.call("session.create", { profile: "droid", source: "tui" });
  const id = created.session_id;
  assert.deepEqual(created.info.mode_options, r.provider.modeOptions);
  assert.equal(created.info.mode, "default");
  assert.deepEqual((await client.call("profiles.list")).profiles[0].mode_options, r.provider.modeOptions);
  assert.deepEqual((await client.call("model.options", { profile: "droid" })).mode_options, r.provider.modeOptions);
  const mode = await client.call("session.set_mode", { session_id: id, profile: "droid", mode: "medium" });
  assert.equal(mode.mode, "medium");
  assert.deepEqual(mode.mode_options, r.provider.modeOptions);
  assert.equal(r.sdk.handles.at(-1)!.settings.autonomyLevel, AutonomyLevel.Medium);
  assert.deepEqual(client.events(id).find((event) => event.type === "session.mode")?.payload.mode_options, r.provider.modeOptions);
  const handle = r.sdk.handles.at(-1)!;
  const waiting = gate();
  t.after(() => waiting.resolve());
  handle.script = async function* (session, text) {
    if (text === "first") await waiting.promise;
    yield { type: "assistant_text_delta", messageId: text, blockIndex: 0, text: `Reply: ${text}` };
    yield result(session.id);
  };
  await client.call("prompt.submit", { session_id: id, profile: "droid", text: "first" });
  const queued = await client.call("prompt.submit", { session_id: id, profile: "droid", text: "second", when_busy: "queue" });
  assert.equal(queued.status, "queued");
  const mark = client.frames.length;
  waiting.resolve();
  await client.from(mark, (frame) => isEvent(frame, "message.delta", id) && frame.params.payload.text === "Reply: second");
  await until(() => client.events(id).filter((event) => event.type === "message.complete").length === 2);
  assert.equal(streamedText(client.events(id)), "Reply: firstReply: second");
  const resumed = await client.call("session.resume", { session_id: id, profile: "droid" });
  assert.equal(resumed.info.mode, "medium");
  assert.deepEqual(resumed.info.mode_options, r.provider.modeOptions);
  assert.equal(resumed.messages.filter((message: { role: string }) => message.role === "user").length, 2);
});

test("Droid saves steering consumption receipts and display history before acknowledging the bridge", async (t) => {
  const r = await rig(t);
  const held = gate();
  t.after(() => held.resolve());
  r.handle.script = async function* (handle) { await held.promise; yield result(handle.id); };
  let sentId: string | undefined;
  r.handle.addScript = async (_params, requestId) => { sentId = requestId; return {}; };
  r.session.startTurn({ text: "first", images: [] });
  await until(() => r.handle.prompts.length === 1);
  assert.equal(await r.session.enqueue({ text: "second", images: [] }, "portals-receipt"), true);
  assert.equal(sentId, "portals-receipt");
  r.handle.notify({ params: { notification: { type: "create_message", requestId: sentId, message: { role: "user" } } } });
  assert.deepEqual(r.provider.store.read("thread").queueReceipts, ["portals-receipt"]);
  assert.equal(r.sink.events.filter((e) => e.type === "queue.consumed").length, 1);
  assert.equal(r.provider.store.read("thread").messages.findLast((m) => m.role === "user")?.display_kind, "steer");
  held.resolve();
  await r.sink.end();
  await r.session.close();
  const resumed = await r.provider.resumeSession(r.options(), new Sink());
  assert.equal(resumed.queuedConsumed("portals-receipt"), true);
  assert.equal(r.sdk.handles.length, 1, "reading a receipt never warms a resumed CLI");
});

test("Droid permission failure cannot restart a waiting prompt under the rolled-back Full mode", async (t) => {
  const r = await rig(t), release = gate(), entered = gate(), closing = gate(), closed = gate();
  let changing: Promise<unknown> | undefined;
  try {
    await r.session.setMode("full");
    r.handle.updateSettings = async () => { entered.resolve(); await release.promise; throw new Error("Refused Ask permission"); };
    changing = r.session.setMode("ask").catch((error: unknown) => error);
    await entered.promise;
    const close = r.handle.close.bind(r.handle);
    r.handle.close = async () => { closing.resolve(); await closed.promise; await close(); };
    r.handle.die();
    await closing.promise;
    const mark = r.sink.events.length;
    r.session.startTurn({ text: "must not restart under Full", images: [] });
    release.resolve();
    assert.match(String(await changing), /Refused Ask permission/);
    closed.resolve();
    const [end] = await r.sink.end(mark);
    assert.equal(r.sdk.handles.reduce((count, handle) => count + handle.prompts.length, 0), 0);
    assert.equal(end.status, "error");
    assert.match(end.type === "turn.end" ? end.error ?? "" : "", /Refused Ask permission/);
    assert.equal((await turn(r.session, r.sink, "still blocked")).status, "error");
    assert.equal(r.sdk.handles.reduce((count, handle) => count + handle.prompts.length, 0), 0);
    await r.session.setMode("ask");
    assert.equal((await turn(r.session, r.sink, "explicit Ask retry")).status, "complete");
    assert.equal(r.sdk.handles.at(-1)!.settings.autonomyLevel, AutonomyLevel.Off);
  } finally { release.resolve(); closed.resolve(); await changing; }
});

test("Droid permission changes do not hand steering to a stream still running under Full", async (t) => {
  const r = await rig(t), held = gate();
  t.after(() => held.resolve());
  await r.session.setMode("full");
  r.handle.script = async function* (handle) { await held.promise; yield result(handle.id); };
  let handed = 0;
  r.handle.addScript = async () => { handed++; return {}; };
  r.session.startTurn({ text: "first under Full", images: [] });
  await until(() => r.handle.prompts.length === 1);
  await r.session.setMode("ask");
  assert.equal(r.handle.settings.autonomyLevel, AutonomyLevel.High);
  assert.equal(await r.session.enqueue({ text: "must ask", images: [] }, "mode-change-steer"), false);
  assert.equal(handed, 0);
});

test("Droid permission changes wait for older model settings that carry the previous policy", async (t) => {
  const r = await rig(t), release = gate(), entered = gate();
  let changingModel: Promise<unknown> | undefined, changingMode: Promise<void> | undefined;
  try {
    await r.session.setMode("full");
    const update = r.handle.updateSettings.bind(r.handle);
    let calls = 0;
    r.handle.updateSettings = async (settings) => {
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return update(settings);
    };
    changingModel = r.session.setModel("large", "droid");
    await entered.promise;
    changingMode = r.session.setMode("ask");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release.resolve();
    await Promise.all([changingModel, changingMode]);
    assert.equal((await turn(r.session, r.sink, "must run with Ask")).status, "complete");
    assert.equal(r.handle.settings.autonomyLevel, AutonomyLevel.Off);
  } finally { release.resolve(); await changingModel; await changingMode; }
});

test("Droid permission failure cannot roll back a newer successful mode choice", async (t) => {
  const r = await rig(t), release = gate(), entered = gate();
  let first: Promise<unknown> | undefined, second: Promise<void> | undefined;
  try {
    const update = r.handle.updateSettings.bind(r.handle);
    r.handle.updateSettings = async (settings) => {
      if (settings.autonomyLevel === AutonomyLevel.High) {
        entered.resolve(); await release.promise; throw new Error("Refused older Full");
      }
      return update(settings);
    };
    first = r.session.setMode("full").catch((error: unknown) => error);
    await entered.promise;
    second = r.session.setMode("ask");
    release.resolve();
    assert.match(String(await first), /Refused older Full/);
    await second;
    assert.equal(r.session.mode().mode, "ask");
    assert.equal((await turn(r.session, r.sink, "latest Ask")).status, "complete");
    assert.equal(r.handle.settings.autonomyLevel, AutonomyLevel.Off);
  } finally { release.resolve(); await first; await second; }
});

test("Droid a subagent's discarded queue or compaction is not the thread's own", async (t) => {
  const r = await rig(t);
  const held = gate();
  t.after(() => held.resolve());
  r.handle.script = async function* (handle) { await held.promise; yield result(handle.id); };
  r.handle.addScript = async () => ({});
  r.session.startTurn({ text: "first", images: [] });
  await until(() => r.handle.prompts.length === 1);
  assert.equal(await r.session.enqueue({ text: "second", images: [] }, "portals-steer"), true);
  r.handle.notify({ params: { sessionId: "child", notification: { type: "queued_messages_discarded" } } });
  r.handle.notify({ params: { sessionId: "child", notification: { type: "session_compacted", summaryId: "child-summary", removedCount: 3 } } });
  assert.equal(r.sink.events.some((event) => event.type === "queue.failed"), false, "the thread's steering message still waits for Droid");
  assert.equal(r.sink.events.some((event) => event.type === "compacted"), false);
  r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "create_message", requestId: "portals-steer", message: { role: "user" } } } });
  assert.equal(r.sink.events.filter((event) => event.type === "queue.consumed").length, 1);
  held.resolve();
  await r.sink.end();
  assert.equal(r.provider.store.read("thread").messages.some((message) => message.role === "compaction"), false);
});

test("Droid opens one process when two callers wake a thread whose Spec handoff waited on background work", async (t) => {
  const r = await rig(t, { backgroundHoldMs: 1000, now: () => 0 });
  await r.session.setMode("plan");
  r.sdk.contexts.set("implementation", r.handle.cwd);
  r.sink.answer = async () => ({ kind: "approval.option", option: "proceed_new_session_low" });
  r.handle.script = async function* (handle) {
    await handle.options.permissionHandler!(specPermission());
    handoffNotifications(handle, "implementation");
    yield { type: "tool_call", name: "Execute", toolUseId: "job", input: { fireAndForget: true } };
    yield { type: "tool_result", toolUseId: "job", toolName: "Execute", isError: false, content: "Background process started (PID: 1)" };
    yield result(handle.id);
  };
  await turn(r.session, r.sink, "plan and implement");
  assert.equal(r.session.hasBackgroundWork(), true);
  assert.equal(r.sdk.handles.length, 1);
  const opened = gate();
  t.after(() => opened.resolve());
  const open = r.sdk.open.bind(r.sdk);
  r.sdk.open = async (options, id) => { await opened.promise; return open(options, id); };
  const mark = r.sink.events.length;
  const renaming = r.session.rename("Both at once");
  r.session.startTurn({ text: "follow up now", images: [] });
  await sleep(20);
  opened.resolve();
  await renaming;
  assert.equal((await r.sink.end(mark))[0].status, "complete");
  assert.equal(r.sdk.handles.length, 2, "one replacement process, not two");
  assert.deepEqual(r.sdk.handles[1].titles, ["Both at once"]);
  assert.equal(r.sdk.handles[1].prompts.at(-1)?.text, "follow up now");
});

test("late steering after the stream loop ends cannot reach idle Droid while context refresh is pending", async (t) => {
  const r = await rig(t), context = gate();
  t.after(() => context.resolve());
  let refreshing = false, steers = 0;
  r.handle.getContextStats = async () => { refreshing = true; await context.promise; return r.handle.context; };
  r.handle.addScript = async () => { steers++; return {}; };
  r.session.startTurn({ text: "reply", images: [] });
  await until(() => refreshing);
  assert.equal(await r.session.enqueue({ text: "late", images: [] }, "late"), false);
  assert.equal(steers, 0);
  context.resolve();
  await r.sink.end();
});

test("a Stop while the thread's settings are applied sends no prompt to Droid", async (t) => {
  const r = await rig(t);
  const applying = gate();
  const update = r.handle.updateSettings.bind(r.handle);
  let held = false;
  r.handle.updateSettings = async (settings) => {
    if (!held) { held = true; await applying.promise; }
    return update(settings);
  };
  r.session.startTurn({ text: "stop me", images: [] });
  await until(() => held);
  assert.equal(await r.session.interrupt(), true);
  applying.resolve();
  assert.equal((await r.sink.end())[0].status, "interrupted");
  assert.equal(r.handle.prompts.length, 0);
  const kept = r.provider.store.read("thread").messages;
  // Stopped, as every agent's stop is kept: an interrupted reply, no failed turn's line (D4).
  assert.deepEqual(kept.map((message) => message.role === "assistant" ? message.display_metadata : message.role === "user" ? message.text : message.role), ["stop me", { interrupted: true }]);
});

test("a new thread whose settings Droid cannot take leaves nothing saved and can be started again", async (t) => {
  const r = await rig(t);
  const options = { ...r.options("refused"), settings: { model: "default", provider: "droid", reasoningEffort: "ultra" } };
  await assert.rejects(r.provider.startSession(options, new Sink()), SettingRefused);
  assert.equal(r.provider.store.exists("refused"), false);
  const started = await r.provider.startSession(r.options("refused"), new Sink());
  assert.equal(r.provider.store.read("refused").session, r.sdk.handles.at(-1)!.id);
  await started.close();
});

test("a process that stops while it starts is not taken for a warm one", async (t) => {
  const r = await rig(t);
  const open = r.sdk.open.bind(r.sdk);
  r.sdk.open = async (options, id) => {
    const handle = await open(options, id);
    handle.updateSettings = async () => { handle.alive = false; return {}; };
    return handle;
  };
  await assert.rejects(r.provider.startSession(r.options("dies"), new Sink()), /stopped while it was starting/);
  assert.equal(r.provider.store.exists("dies"), false);
  assert.equal(r.sdk.handles.at(-1)!.closed, 1);
  assert.equal(r.provider.pool.has(r.session), true, "the first thread is unaffected");
});

test("a reasoning level the model no longer takes fails the turn with a way out and keeps the process", async (t) => {
  const r = await rig(t);
  const model = ModelInfoSchema.parse({
    id: "small", displayName: "small", shortDisplayName: "small", modelProvider: "factory",
    supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high",
  });
  r.provider.model = () => model;
  const opens = r.sdk.opens.length;
  const end = await turn(r.session, r.sink, "hello");
  assert.equal(end.status, "error");
  assert.match(end.error!, /Choose another model or reasoning level/);
  assert.equal(r.handle.closed, 0);
  assert.equal(r.handle.prompts.length, 0);
  assert.equal(r.sdk.opens.length, opens);
});

test("a long turn writes the conversation now and then, and all of it at the end", async (t) => {
  const r = await rig(t);
  let writes = 0;
  const write = r.provider.store.write.bind(r.provider.store);
  r.provider.store.write = (thread) => { writes++; write(thread); };
  r.handle.script = async function* (handle) {
    for (let n = 0; n < 50; n++) {
      yield { type: "tool_call", name: "Read", toolUseId: `read-${n}`, input: { file_path: `/tmp/${n}.txt` } };
      yield { type: "tool_result", toolName: "Read", toolUseId: `read-${n}`, content: "text", isError: false };
    }
    yield result(handle.id);
  };
  assert.equal((await turn(r.session, r.sink, "read them all")).status, "complete");
  assert.ok(writes <= 4, `${writes} writes for 100 tool events`);
  assert.equal(r.provider.store.read("thread").messages.filter((message) => message.role === "tool").length, 50);
});

test("the model list asked for while Droid is still telling it waits for it", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "portals-droid-test-"));
  const sdk = new Sdk();
  const listing = gate();
  const models = sdk.models.bind(sdk);
  sdk.models = async () => { await listing.promise; return models(); };
  const provider = new DroidProvider({ command: "/not-a-real-droid", directory, idleMs: 100, maxWarm: 2, sdk, checkVersion: false });
  t.after(async () => { await provider.close(); rmSync(directory, { recursive: true, force: true }); });
  provider.start();
  const catalog = provider.models();
  listing.resolve();
  assert.deepEqual((await catalog).providers[0].models, ["default", "small", "large"]);
});

test("a kept model list is answered at once, and an old one is asked for again in the background", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "portals-droid-test-"));
  const sdk = new Sdk();
  const listing = gate();
  const models = sdk.models.bind(sdk);
  let now = 0, asked = 0;
  sdk.models = async () => {
    if (++asked === 1) return models();
    await listing.promise;
    return (await models()).slice(1);
  };
  const provider = new DroidProvider({ command: "/not-a-real-droid", directory, idleMs: 100, maxWarm: 2, sdk, checkVersion: false, now: () => now });
  t.after(async () => { await provider.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual((await provider.models()).providers[0].models, ["default", "small", "large"]);
  now += 10 * 60_000 + 1;
  // Droid has not answered again yet: the kept list is answered without waiting for it.
  assert.deepEqual((await provider.models()).providers[0].models, ["default", "small", "large"]);
  assert.equal(asked, 2);
  listing.resolve();
  await until(() => provider.model("small") === undefined);
  assert.deepEqual((await provider.models()).providers[0].models, ["default", "large"]);
  assert.equal(asked, 2);
});

test("Droid uses per-turn final usage and persists the cumulative baseline for live usage after restart", async (t) => {
  const r = await rig(t);
  const usage = (total: number) => ({ inputTokens: Math.max(0, total - 300), outputTokens: total ? 100 : 0,
    cacheReadTokens: total ? 150 : 0, cacheCreationTokens: total ? 50 : 0, thinkingTokens: 40 });
  let whole = 0;
  const script: Script = async function* (handle) {
    yield { type: "token_usage_update", ...usage(whole) };
    whole += 10_000;
    yield { type: "token_usage_update", ...usage(whole) };
    yield { ...result(handle.id), durationMs: 2_500, tokenUsage: usage(10_000) } as DroidStreamEvent;
  };
  r.handle.script = script;
  const open = r.sdk.open.bind(r.sdk);
  r.sdk.open = async (options, id) => {
    const handle = await open(options, id);
    handle.script = script;
    return handle;
  };
  // A new session: nothing spent before its first turn.
  assert.deepEqual((await turn(r.session, r.sink, "one")).spent, { seconds: 2.5, tokens: 10_000 });
  assert.deepEqual((await turn(r.session, r.sink, "two")).spent, { seconds: 2.5, tokens: 10_000 });
  assert.equal(r.provider.store.read("thread").sessionTokens, 20_000);
  // The persisted cumulative baseline makes the first resumed turn live, too.
  await r.session.close();
  const sink = new Sink();
  const resumed = await r.provider.resumeSession(r.options(), sink);
  // What the turns before the restart spent is still with them, and their times are in seconds.
  const stored = await resumed.history();
  assert.deepEqual(stored.filter((message) => message.turn_usage).map((message) => message.turn_usage), [{ seconds: 2.5, tokens: 10_000 }, { seconds: 2.5, tokens: 10_000 }]);
  assert.ok(stored.every((message) => Math.abs(message.timestamp - Date.now() / 1000) < 60), "timestamps in seconds");
  assert.deepEqual((await turn(resumed, sink, "three")).spent, { seconds: 2.5, tokens: 10_000 });
  assert.deepEqual(sink.events.filter((event) => event.type === "turn.usage").map((event) => event.usage.tokens), [0, 10_000]);
  assert.deepEqual((await turn(resumed, sink, "four")).spent, { seconds: 2.5, tokens: 10_000 });
});

test("recorded delegated cost never becomes the parent-only live baseline, including after restart", async (t) => {
  const records = readFileSync(new URL("./fixtures/droid/subagent.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const parent = records.findLast((r) => r.event?.type === "token_usage_update").event as Extract<DroidStreamEvent, { type: "token_usage_update" }>;
  const completed = records.findLast((r) => r.notification?.params?.notification?.type === "agent_turn_completed").notification.params.notification;
  const parentTokens = tokenTotal(parent);
  const completedTokens = tokenTotal(completed.cumulativeTokenUsage);
  assert.ok(parentTokens !== undefined && completedTokens !== undefined);
  assert.ok(parentTokens > 0);
  assert.ok(completedTokens > parentTokens, "the completed turn includes delegated cost");
  const r = await rig(t);
  r.handle.script = async function* (handle) {
    yield parent;
    handle.notify({ params: { sessionId: handle.id, notification: completed } });
    yield result(handle.id);
  };
  await turn(r.session, r.sink, "delegate");
  assert.equal(r.provider.store.read("thread").sessionTokens, completedTokens);
  assert.equal(r.provider.store.read("thread").liveSessionTokens, parentTokens);
  r.handle.script = async function* (handle) {
    yield { ...parent, outputTokens: parent.outputTokens + 1000 };
    yield result(handle.id);
  };
  const mark = r.sink.events.length;
  await turn(r.session, r.sink, "next");
  assert.deepEqual(r.sink.events.slice(mark).filter((e) => e.type === "turn.usage").map((e) => e.usage.tokens), [1000]);
  assert.ok(r.session.cost().includes(`Tokens: ${completedTokens}`), "a later parent-only sample cannot erase observed delegated cost");
  await r.session.close();
  const sink = new Sink();
  const resumed = await r.provider.resumeSession(r.options(), sink);
  const open = r.sdk.open.bind(r.sdk);
  r.sdk.open = async (options, id) => {
    const handle = await open(options, id);
    handle.script = async function* () {
      yield { ...parent, outputTokens: parent.outputTokens + 2000 };
      yield result(handle.id);
    };
    return handle;
  };
  await turn(resumed, sink, "after restart");
  assert.deepEqual(sink.events.filter((e) => e.type === "turn.usage").map((e) => e.usage.tokens), [1000]);
  await resumed.close();
  const legacy = r.provider.store.read("thread");
  delete legacy.liveSessionTokens;
  r.provider.store.write(legacy);
  const unknownSink = new Sink();
  const legacySession = await r.provider.resumeSession(r.options(), unknownSink);
  await turn(legacySession, unknownSink, "legacy unknown basis");
  assert.equal(unknownSink.events.filter((e) => e.type === "turn.usage").length, 0,
    "a cost-only legacy baseline does not invent a live turn count");
});

test("raw retry notices are scoped to their live Droid handle and omit raw error secrets", async (t) => {
  const r = await rig(t);
  const wait = gate();
  r.handle.script = async function* (handle) {
    handle.notify({ params: { notification: { type: "llm_retry", attempt: 2, message: "SECRET_OAUTH_URL", state: "SECRET_STATE" } } });
    await wait.promise;
    yield result(handle.id);
  };
  r.session.startTurn({ text: "retry", images: [] });
  await until(() => r.sink.events.some((event) => event.type === "notice"));
  assert.deepEqual(r.sink.events.filter((event) => event.type === "notice"), [
    { type: "notice", level: "warn", text: "Droid is retrying the model request (attempt 2)." },
  ]);
  wait.resolve();
  await r.sink.end();
  await r.session.close();
  const count = r.sink.events.length;
  r.handle.notify({ params: { notification: { type: "llm_retry", attempt: 3 } } });
  assert.equal(r.sink.events.length, count);
});

test("Droid reads estimated context on open and after turns, and restores the meter without warming every saved session", async (t) => {
  const r = await rig(t);
  assert.deepEqual(r.provider.store.read("thread").contextUsage, { used: 100, max: 1000, estimated: true });
  r.handle.context = { ...r.handle.context, used: 250, limit: 872_000, accuracy: ContextStatsAccuracy.Exact };
  await turn(r.session, r.sink, "hello");
  assert.deepEqual(r.sink.events.findLast((event) => event.type === "usage"), { type: "usage", usage: { used: 250, max: 872_000 } });
  await r.session.close();
  const sink = new Sink(), opens = r.sdk.opens.length;
  const resumed = await r.provider.resumeSession(r.options(), sink);
  await resumed.history();
  resumed.attached();
  assert.equal(r.sdk.opens.length, opens);
  assert.deepEqual(sink.events, [{ type: "usage", usage: { used: 250, max: 872_000 } }]);
});

test("Droid's meter shows what its last call took, not its estimate, which counts what compactions took out (2026-10-27)", async (t) => {
  const r = await rig(t);
  const usage = () => r.sink.events.findLast((event) => event.type === "usage");
  // Droid's estimate of a long thread: every message it ever had, against the model's limit.
  r.handle.context = { ...r.handle.context, used: 868_281, limit: 872_000 };
  const tokenUsage = { inputTokens: 673_320, outputTokens: 223_269, cacheCreationTokens: 1_367_939, cacheReadTokens: 30_217_519, thinkingTokens: 84_059 };
  // Droid at work, as it says before each of its calls (a call it reports otherwise is a side call's, D2).
  tell(r.handle, { type: "droid_working_state_changed", newState: "streaming_assistant_message" });
  r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "session_token_usage_changed", tokenUsage,
    lastCallTokenUsage: { inputTokens: 908, cacheReadTokens: 137_309, outputTokens: 1004 } } } });
  assert.deepEqual(usage(), { type: "usage", usage: { used: 139_221, max: 1000 } }, "at once, against the limit known so far");
  await turn(r.session, r.sink, "hello");
  assert.deepEqual(usage(), { type: "usage", usage: { used: 139_221, max: 872_000 } }, "the estimate's limit, not its count");
  assert.deepEqual(r.provider.store.read("thread").contextUsage, { used: 139_221, max: 872_000 });
  await r.session.close();
  // Resumed: what Droid says the session's last call took as it loads it.
  r.sdk.loaded = { inputTokens: 1000, cacheReadTokens: 2000 };
  const sink = new Sink();
  const resumed = await r.provider.resumeSession(r.options(), sink);
  await turn(resumed, sink, "after a restart");
  // (A new process's stand-in estimates 100 of 1000.)
  assert.deepEqual(sink.events.findLast((event) => event.type === "usage"), { type: "usage", usage: { used: 3000, max: 1000 } });
  await resumed.close();
  // Loaded with none: the meter as it last read it, not the estimate.
  r.sdk.loaded = undefined;
  const again = new Sink();
  const reopened = await r.provider.resumeSession(r.options(), again);
  await turn(reopened, again, "again");
  assert.deepEqual(again.events.findLast((event) => event.type === "usage"), { type: "usage", usage: { used: 3000, max: 1000 } });
});

/** Droid's `session_token_usage_changed` as it sends it: the session's id inside the notification, none on the envelope (every fixture). */
function lastCall(h: Handle, lastCallTokenUsage: Record<string, number>, sessionId = h.id): void {
  h.notify({ params: { notification: { type: "session_token_usage_changed", sessionId, lastCallTokenUsage,
    tokenUsage: { inputTokens: 4, outputTokens: 6, cacheCreationTokens: 19_154, cacheReadTokens: 0, thinkingTokens: 0 } } } });
}

test("Droid's meter takes only the conversation's calls: not the session's naming, which Droid reports after a new thread's first turn, nor another session's (D2)", async (t) => {
  const r = await rig(t);
  const usage = () => r.sink.events.findLast((event) => event.type === "usage");
  r.handle.context = { ...r.handle.context, limit: 872_000 };
  // fixtures/droid/compact.jsonl's first turn: at work, its call (19,158 in, 6 out), its end, idle.
  r.handle.script = async function* (h) {
    tell(h, { type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    lastCall(h, { inputTokens: 19_158, cacheReadTokens: 0, outputTokens: 6 });
    yield { type: "assistant_text_delta", messageId: "m", blockIndex: 0, text: "remembered." };
    tell(h, { type: "agent_turn_completed", reason: "completed", turnId: "t1", tokenUsage: { inputTokens: 4, outputTokens: 6, cacheCreationTokens: 19_154, cacheReadTokens: 0, thinkingTokens: 0 } });
    tell(h, { type: "droid_working_state_changed", newState: "idle" });
    yield result(h.id);
  };
  await turn(r.session, r.sink, "Remember the word pear.");
  assert.deepEqual(usage(), { type: "usage", usage: { used: 19_164, max: 872_000 } });
  // Then the naming call's figure (351 in, 4 out), twice, and the name: a side call, not the conversation's.
  lastCall(r.handle, { inputTokens: 351, cacheReadTokens: 0, outputTokens: 4 });
  lastCall(r.handle, { inputTokens: 351, cacheReadTokens: 0, outputTokens: 4 });
  tell(r.handle, { type: "session_title_updated", title: "remembered", updateType: "llm_generated" });
  assert.deepEqual(usage(), { type: "usage", usage: { used: 19_164, max: 872_000 } });
  assert.deepEqual(r.provider.store.read("thread").contextUsage, { used: 19_164, max: 872_000 });
  // At work again: a call of another session's (a subagent's) is not the thread's; the thread's next one is.
  tell(r.handle, { type: "droid_working_state_changed", newState: "thinking" });
  lastCall(r.handle, { inputTokens: 50_000, cacheReadTokens: 0, outputTokens: 10 }, "child-session");
  assert.deepEqual(usage(), { type: "usage", usage: { used: 19_164, max: 872_000 } });
  lastCall(r.handle, { inputTokens: 4771, cacheReadTokens: 14_625, outputTokens: 4 });
  assert.deepEqual(usage(), { type: "usage", usage: { used: 19_400, max: 872_000 } });
});

/** Droid's `/context` breakdown, which counts what the conversation has since its latest compaction (CLI 0.250's `get_context_breakdown`). */
function breakdown(usedTokens: number) {
  return ContextBreakdownResultSchema.parse({
    modelId: "small", modelDisplayName: "Small", contextBudget: 800_000, usedTokens, freeTokens: 800_000 - usedTokens,
    categories: [{ name: "Messages", tokens: usedTokens, colorKey: "messages" }], skills: [], mcpServers: [], droids: [],
  });
}

test("after a compaction, the person's or Droid's own, the meter reads what is left of the conversation until Droid's next call, not Droid's count of every message the session ever had (D3)", async (t) => {
  const r = await rig(t);
  const usage = () => r.sink.events.findLast((event) => event.type === "usage");
  // A long thread: Droid's count of every message it ever had (get_context_stats), and its last call.
  r.handle.context = { ...r.handle.context, used: 868_281, limit: 872_000 };
  r.handle.breakdown = breakdown(400_000);
  tell(r.handle, { type: "droid_working_state_changed", newState: "streaming_assistant_message" });
  lastCall(r.handle, { inputTokens: 908, cacheReadTokens: 137_309, outputTokens: 1004 });
  await turn(r.session, r.sink, "hello");
  assert.deepEqual(usage(), { type: "usage", usage: { used: 139_221, max: 800_000 } });

  // /compact: the compaction's own call, reported before Droid says it compacted and again after
  // (fixtures/droid/compact.jsonl), on the same session id, as CLI 0.245 keeps it.
  const next = new Handle(r.handle.id, r.handle.cwd, r.handle.options);
  next.settings = { ...r.handle.settings };
  next.context = { ...r.handle.context };
  next.breakdown = breakdown(21_000);
  r.handle.compactScript = async () => {
    lastCall(r.handle, { inputTokens: 139_000, cacheReadTokens: 0, outputTokens: 2000 });
    tell(r.handle, { type: "session_compacted", summaryId: "summary-1", removedCount: 40, visibleBoundaryMessageId: null });
    lastCall(r.handle, { inputTokens: 139_000, cacheReadTokens: 0, outputTokens: 2000 });
    return { session: next, removedCount: 40 };
  };
  assert.equal((await turn(r.session, r.sink, "/compact")).status, "complete");
  assert.deepEqual(usage(), { type: "usage", usage: { used: 21_000, max: 800_000, estimated: true } }, "what is left, not 868,281");
  // The compaction's figure said again (Droid repeats its last call's whenever the session's totals change) is no new call.
  tell(next, { type: "droid_working_state_changed", newState: "thinking" });
  lastCall(next, { inputTokens: 139_000, cacheReadTokens: 0, outputTokens: 2000 });
  assert.deepEqual(usage(), { type: "usage", usage: { used: 21_000, max: 800_000, estimated: true } });
  lastCall(next, { inputTokens: 900, cacheReadTokens: 21_000, outputTokens: 100 });
  assert.deepEqual(usage(), { type: "usage", usage: { used: 22_000, max: 800_000 } });

  // Droid compacting by itself, mid-turn: its compaction call, its word, the same figure again.
  lastCall(next, { inputTokens: 300_000, cacheReadTokens: 0, outputTokens: 3000 });
  tell(next, { type: "session_compacted", summaryId: "summary-2", removedCount: 50, visibleBoundaryMessageId: null });
  lastCall(next, { inputTokens: 300_000, cacheReadTokens: 0, outputTokens: 3000 });
  await until(() => (usage() as { usage?: { estimated?: boolean } } | undefined)?.usage?.estimated === true);
  assert.deepEqual(usage(), { type: "usage", usage: { used: 21_000, max: 800_000, estimated: true } }, "what is left, not the figure from before");
  lastCall(next, { inputTokens: 1000, cacheReadTokens: 20_000, outputTokens: 50 });
  assert.deepEqual(usage(), { type: "usage", usage: { used: 21_050, max: 800_000 } });
});

/** A thread on a long conversation (its last call 139,221), compacted with /compact, which leaves 21,000; the compaction's own call took 141,000. */
async function compactedThread(t: TestContext) {
  const r = await rig(t);
  r.handle.context = { ...r.handle.context, used: 868_281, limit: 872_000 };
  tell(r.handle, { type: "droid_working_state_changed", newState: "streaming_assistant_message" });
  lastCall(r.handle, { inputTokens: 908, cacheReadTokens: 137_309, outputTokens: 1004 });
  await turn(r.session, r.sink, "hello");
  const next = new Handle(r.handle.id, r.handle.cwd, r.handle.options);
  next.settings = { ...r.handle.settings };
  next.context = { ...r.handle.context };
  next.breakdown = breakdown(21_000);
  return { ...r, next, compaction: async () => {
    lastCall(r.handle, { inputTokens: 139_000, cacheReadTokens: 0, outputTokens: 2000 });
    tell(r.handle, { type: "session_compacted", summaryId: "summary-1", removedCount: 40, visibleBoundaryMessageId: null });
    return { session: next, removedCount: 40 };
  } };
}

test("a thread compacted and reopened before Droid's next call reads what is left, not the compaction's own call, which Droid saved as the session's last (Codex's review of n14/droid, P2)", async (t) => {
  const r = await compactedThread(t);
  r.handle.compactScript = r.compaction;
  await turn(r.session, r.sink, "/compact");
  assert.deepEqual(r.provider.store.read("thread").contextUsage, { used: 21_000, max: 800_000, estimated: true });
  await r.session.close();
  // Droid loads the session with the compaction's call as its last.
  r.sdk.loaded = { inputTokens: 139_000, cacheReadTokens: 0, outputTokens: 2000 };
  const open = r.sdk.open.bind(r.sdk);
  r.sdk.open = async (...args: Parameters<Sdk["open"]>) => {
    const handle = await open(...args);
    handle.context = { ...handle.context, used: 868_281, limit: 872_000 };
    handle.breakdown = breakdown(21_500);
    return handle;
  };
  const sink = new Sink();
  const resumed = await r.provider.resumeSession(r.options(), sink);
  await turn(resumed, sink, "after a restart");
  assert.deepEqual(sink.events.findLast((event) => event.type === "usage"), { type: "usage", usage: { used: 21_500, max: 800_000, estimated: true } });
  // Droid's next call is taken, and from then on what Droid loads is trusted again.
  const h = r.sdk.handles.at(-1)!;
  tell(h, { type: "droid_working_state_changed", newState: "thinking" });
  lastCall(h, { inputTokens: 1000, cacheReadTokens: 21_000, outputTokens: 50 });
  assert.deepEqual(sink.events.findLast((event) => event.type === "usage"), { type: "usage", usage: { used: 22_050, max: 800_000 } });
  assert.equal(r.provider.store.read("thread").staleCall, undefined);
  await resumed.close();
  r.sdk.loaded = { inputTokens: 1000, cacheReadTokens: 21_000, outputTokens: 50 };
  const again = new Sink();
  const reopened = await r.provider.resumeSession(r.options(), again);
  await turn(reopened, again, "again");
  assert.deepEqual(again.events.findLast((event) => event.type === "usage"), { type: "usage", usage: { used: 22_050, max: 800_000 } });
});

test("a thread compacted whose meter was not read again before it closed reopens to what is left, not the figure kept from before (Codex's re-check, P2)", async (t) => {
  const r = await compactedThread(t);
  r.handle.compactScript = r.compaction;
  r.next.getContextStats = async () => { throw new Error("Droid took too long to answer droid.get_context_stats."); };
  await turn(r.session, r.sink, "/compact");
  const saved = r.provider.store.read("thread");
  // The compaction's own call, which the meter took as /compact ran, and not read again since.
  assert.deepEqual(saved.contextUsage, { used: 141_000, max: 872_000 });
  assert.equal(saved.staleCall, "139000/0/2000");
  await r.session.close();
  r.sdk.loaded = { inputTokens: 139_000, cacheReadTokens: 0, outputTokens: 2000 };
  const open = r.sdk.open.bind(r.sdk);
  r.sdk.open = async (...args: Parameters<Sdk["open"]>) => {
    const handle = await open(...args);
    handle.context = { ...handle.context, used: 868_281, limit: 872_000 };
    handle.breakdown = breakdown(21_500);
    return handle;
  };
  const sink = new Sink();
  await turn(await r.provider.resumeSession(r.options(), sink), sink, "after a restart");
  assert.deepEqual(sink.events.findLast((event) => event.type === "usage"), { type: "usage", usage: { used: 21_500, max: 800_000, estimated: true } });
});

test("a /compact that Droid finishes after a Stop still sets the meter to what is left (Codex's review of n14/droid, P2)", async (t) => {
  const r = await compactedThread(t);
  const waiting = gate(), entered = gate();
  r.handle.compactScript = async () => { entered.resolve(); await waiting.promise; return r.compaction(); };
  const mark = r.sink.events.length;
  r.session.startTurn({ text: "/compact", images: [] });
  await entered.promise;
  assert.equal(await r.session.interrupt(), true);
  await r.sink.end(mark);
  waiting.resolve();
  await until(() => r.provider.store.read("thread").session === r.next.id && r.sink.events.some((event) => event.type === "compacted"));
  await until(() => (r.sink.events.findLast((event) => event.type === "usage") as { usage?: { used?: number } } | undefined)?.usage?.used === 21_000);
  assert.deepEqual(r.provider.store.read("thread").contextUsage, { used: 21_000, max: 800_000, estimated: true });
});

/** A recording of Droid's (fixtures/droid), its session's id as the stand-in's: what Droid said, in the order it said it. */
function recording(name: string, session: string) {
  const text = readFileSync(new URL(`./fixtures/droid/${name}.jsonl`, import.meta.url), "utf8");
  const recorded = (JSON.parse(text.split("\n").find((line) => line.includes('"kind":"session"'))!) as { sessionId: string }).sessionId;
  return text.replaceAll(recorded, session).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
}

/**
 * Droid's side of a turn as recorded from `from` to `to`: its notifications told, its
 * stream's events given and its approvals asked through the session's own handler, in order.
 */
function replayed(handle: Handle, records: Record<string, any>[], from: number, to: number): Script {
  return async function* () {
    for (const record of records.slice(from, to)) {
      if (record.kind === "notification") handle.notify(record.notification);
      else if (record.kind === "event") yield record.event as DroidStreamEvent;
      else if (record.kind === "permission") await handle.options.permissionHandler!(record.params);
    }
  };
}

for (const name of ["task-stop-background", "task-stop-foreground", "task-stop-tool-id", "task-stop-idle"]) {
  test(`Droid stop probe (${name}): a worker-kill response is not a Task outcome, and no unsafe Stop is offered`, async (t) => {
    const r = await rig(t);
    const records = recording(name, r.handle.id);
    const firstResult = records.findIndex((record) => record.kind === "event" && record.event.type === "result");
    const control = records.find((record) => record.kind === "control" && record.call === "kill_worker_session")!;
    const response = records.find((record) => record.kind === "response" && record.call === "kill_worker_session")!;
    const child = records.find((record) => record.kind === "notification"
      && record.notification.params?.notification?.type === "child_session_available")!.notification.params.notification;
    assert.equal(control.params.workerSessionId, name === "task-stop-tool-id" ? child.toolUseId : child.childSessionId);
    if (name === "task-stop-idle") {
      assert.match(response.result.error, /No active execution to interrupt/);
      assert.deepEqual(records.find((record) => record.kind === "response" && record.call === "kill_background_process")!.result, { killed: false });
    } else {
      assert.deepEqual(response.result, {});
      // It stops the parent: its turn as interrupted, or (Droid 1.3, the parent waiting on the
      // Task's output) the parent's running tool as cancelled, its turn then ending as completed.
      assert.ok(records.some((record) => record.kind === "notification"
        && (record.notification.params?.notification?.message?.content?.some((block: { text?: string }) => block.text === "Request interrupted by user")
          || record.notification.params?.notification?.content === "Error: Tool execution cancelled by user")));
    }
    r.sink.answer = async () => ({ kind: "approval", choice: "once" });
    r.handle.script = replayed(r.handle, records, records.findIndex((record) => record.kind === "send") + 1, firstResult + 1);
    assert.equal((await turn(r.session, r.sink, records.find((record) => record.kind === "send")!.prompt)).status, "complete");
    assert.equal(r.session.hasBackgroundWork(), true, "the Task still runs after the parent turn ends");
    assert.equal(r.provider.store.read("thread").subagents![0].status, "running");
    assert.equal(r.provider.store.read("thread").subagents![0].stoppable, false);
    assert.equal("stopSubagent" in r.session, false, "the mission worker RPC must not become an individual Task stop");
    const mark = r.sink.events.length;
    for (const record of records.slice(firstResult + 1)) {
      if (record.kind === "notification") r.handle.notify(record.notification);
      else if (record.kind === "permission") await r.handle.options.permissionHandler!(record.params);
    }
    const saved = r.provider.store.read("thread").subagents![0];
    assert.equal(saved.status, "completed", "the child completed normally despite the stop probe");
    assert.equal(saved.result, "pear");
    assert.equal(saved.stoppable, false);
    assert.equal(r.session.hasBackgroundWork(), false);
    const own = r.sink.events.slice(mark).filter((event) => event.type === "turn.begin" || event.type === "turn.end");
    assert.deepEqual(own.map((event) => event.type === "turn.end" ? event.status : event.type), ["turn.begin", "complete"]);
    assert.equal(r.handle.interrupted, false, "the bridge itself sent no parent interrupt");
  });
}

test("the meter through a real Droid's turn, /compact and next turn (fixtures/droid/meter.jsonl, Droid 1.0.0 and SDK 0.10.0): the conversation's call; after /compact what is left; then the next call; each against Droid's own budget (D2, D3)", async (t) => {
  const r = await rig(t);
  const records = recording("meter", r.handle.id);
  const usage = () => (r.sink.events.findLast((event) => event.type === "usage") as { usage?: unknown } | undefined)?.usage;
  const index = (match: (record: Record<string, any>) => boolean) => records.findIndex(match);
  const sends = records.flatMap((record, at) => record.kind === "send" ? [at] : []);
  const compacting = index((record) => record.kind === "control" && record.call === "compact");
  const compacted = index((record) => record.kind === "response" && record.call === "compact");
  const stats = (step: string) => records.find((record) => record.kind === "context" && record.step === step)!.stats;
  const breakdown = (step: string) => ContextBreakdownResultSchema.parse(records.find((record) => record.kind === "breakdown" && record.step === step)!.breakdown);

  r.handle.context = stats("after the first turn");
  r.handle.breakdown = breakdown("after the first turn");
  r.handle.script = replayed(r.handle, records, sends[0] + 1, compacting);
  await turn(r.session, r.sink, records[sends[0]].prompt);
  // The turn's call (19,137 in, 6 out), not the naming's (351 in, 4 out); out of what Droid's
  // /context weighs it against (`contextBudget`), not get_context_stats's limit of 872,000.
  assert.equal(stats("after the first turn").limit, 872_000);
  assert.deepEqual(usage(), { used: 19_143, max: 200_000 });

  const next = new Handle(r.handle.id, r.handle.cwd, r.handle.options);
  next.settings = { ...r.handle.settings };
  next.context = stats("after compacting");
  next.breakdown = breakdown("after compacting");
  r.handle.compactScript = async () => {
    for (const record of records.slice(compacting + 1, compacted)) if (record.kind === "notification") r.handle.notify(record.notification);
    return { session: next, removedCount: 4 };
  };
  assert.equal((await turn(r.session, r.sink, "/compact")).status, "complete");
  // What is left (Droid's /context), not get_context_stats's 12,678, unchanged by the compaction, nor its own call's 1,017.
  assert.deepEqual(usage(), { used: 10_420, max: 200_000, estimated: true });

  next.context = stats("after the turn after compacting");
  next.breakdown = breakdown("after the turn after compacting");
  next.script = replayed(next, records, sends[1] + 1, records.length);
  await turn(r.session, r.sink, records[sends[1]].prompt);
  assert.deepEqual(usage(), { used: 19_419, max: 200_000 });
});

test("a Script Droid starts in the background, through a real Droid (fixtures/droid/script-background.jsonl, gpt-6.1-sol on Droid 1.0.0, SDK 0.10.0): its approval on the card, its process held while it runs, and Droid's turn for its completion told and ended (D1, D11)", async (t) => {
  const r = await rig(t);
  const records = recording("script-background", r.handle.id);
  const result = records.findIndex((record) => record.kind === "event" && record.event.type === "result");
  r.sink.answer = async () => ({ kind: "approval", choice: "once" });
  r.handle.script = replayed(r.handle, records, records.findIndex((record) => record.kind === "send") + 1, result + 1);
  await turn(r.session, r.sink, records.find((record) => record.kind === "send")!.prompt);
  // The approval Droid asked: the Script, then the command it runs, as the command's own would.
  const approval = r.sink.requests.find((request) => request.kind === "approval");
  assert.ok(approval?.kind === "approval");
  assert.equal(approval.description, "Droid wants permission for what this Script does");
  assert.deepEqual(approval.details?.map((detail) => [detail.name, detail.type, detail.command ?? detail.impact]),
    [["Script", "script", "low"], ["Execute", "exec", "sleep 30; echo slept"]]);
  // At rest with the Script at work: its process is held.
  assert.equal(r.session.hasBackgroundWork(), true);
  await r.session.cool();
  r.provider.pool.sweep(Date.now() + 5000);
  assert.equal(r.handle.closed, 0);
  // Thirty seconds on: its command's end, its completion, and Droid's turn for it.
  const mark = r.sink.events.length;
  for (const record of records.slice(result + 1)) if (record.kind === "notification") r.handle.notify(record.notification);
  const told = r.sink.events.slice(mark);
  assert.deepEqual(told.filter((event) => event.type === "turn.begin" || event.type === "turn.end").map((event) => event.type === "turn.end" ? `end ${event.status}` : "begin"), ["begin", "end complete"]);
  assert.ok(streamedTextOf(told).length > 0, "Droid's answer to the completion reaches the app");
  assert.equal(r.session.hasBackgroundWork(), false);
  // The command the Script ran, which the turn ended under: its row has its real end, told at rest (D13).
  const command = records.find((record) => record.kind === "event" && record.event.type === "tool_call" && record.event.name === "Execute")!.event.toolUseId as string;
  const row = (await r.session.history()).find((message) => message.role === "tool" && message.tool_call_id === command);
  assert.ok(row?.role === "tool");
  assert.match(row.content ?? "", /slept/);
  assert.doesNotMatch(row.content ?? "", /turn ended before/);
  assert.ok(told.some((event) => event.type === "tool.end" && event.id === command));
});

test("a background Task's child that asks for approval after the turn has ended asks on its own card, through a real Droid (fixtures/droid/task-background-late-approval-0.247.jsonl, Droid 0.247.0, SDK 0.10.0): it was refused (D12)", async (t) => {
  const r = await rig(t);
  const records = recording("task-background-late-approval-0.247", r.handle.id);
  const result = records.findIndex((record) => record.kind === "event" && record.event.type === "result");
  const permission = records.findIndex((record) => record.kind === "permission");
  assert.ok(result >= 0 && permission > result, "the recording itself must ask after the turn ends");
  r.handle.script = replayed(r.handle, records, records.findIndex((record) => record.kind === "send") + 1, result + 1);
  await turn(r.session, r.sink, records.find((record) => record.kind === "send")!.prompt);
  assert.equal(r.session.hasBackgroundWork(), true, "the Task runs on");
  // 0.8 s after the turn's end: its child asks to run its command (the parent's handler, the child's session among the ids).
  const asking = records[permission].params;
  r.sink.answer = async () => ({ kind: "approval", choice: "once" });
  assert.equal(await r.handle.options.permissionHandler!(asking), ToolConfirmationOutcome.ProceedOnce);
  const card = r.sink.requests.at(-1);
  assert.ok(card?.kind === "approval");
  assert.equal(card.subagent, asking.associatedSessionIds[0], "the child's card: the turn's end does not take it back");
  assert.deepEqual(card.details?.map((detail) => detail.command), ["sleep 20; echo done"]);
  // Its completion, and Droid's turn for it.
  const mark = r.sink.events.length;
  for (const record of records.slice(result + 1)) if (record.kind === "notification") r.handle.notify(record.notification);
  assert.deepEqual(r.sink.events.slice(mark).filter((event) => event.type === "turn.begin" || event.type === "turn.end").map((event) => event.type), ["turn.begin", "turn.end"]);
  assert.equal(r.session.hasBackgroundWork(), false);
  // Another session's request with no Task of the thread's behind it, at rest, is still refused.
  assert.equal(await r.handle.options.permissionHandler!({ ...asking, associatedSessionIds: ["unknown-session"] }), "cancel");
});

test("a call's result Droid tells after the turn's end at Droid's, while the bridge still closes the turn, still goes to its row (Codex's review of the SDK move, P2)", async (t) => {
  const r = await rig(t);
  for (const late of [false, true]) {
    const id = `inner-${late ? "late" : "on-time"}`;
    r.handle.script = async function* (h) {
      tell(h, { type: "create_message", message: { id: `m-${id}`, role: "assistant", createdAt: 1, updatedAt: 1,
        content: [{ type: "tool_use", id, name: "Execute", input: { command: "sleep 30; echo slept" } }] } });
      if (!late) yield { type: "tool_call", name: "Execute", toolUseId: id, input: { command: "sleep 30; echo slept" } };
      tell(h, { type: "agent_turn_completed", reason: "completed", turnId: `t-${id}`, tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
      // Its end, told raw, before the bridge has closed the turn.
      tell(h, { type: "tool_result", toolUseId: id, content: "slept", isError: false });
      // The stream's announcement of it can come after that (Codex's re-check): the result is still its.
      if (late) yield { type: "tool_call", name: "Execute", toolUseId: id, input: { command: "sleep 30; echo slept" } };
      yield result(h.id);
    };
    await turn(r.session, r.sink, `run it in a script (${id})`);
    const row = (await r.session.history()).find((message) => message.role === "tool" && message.tool_call_id === id);
    assert.ok(row?.role === "tool");
    assert.match(row.content ?? "", /slept/, id);
  }
});

test("a result kept for a call the turn may still close under is not a later call's under the same id: one the stream gave, or one before the later call, is let go of (Codex's re-check, P2)", async (t) => {
  const r = await rig(t);
  // call_0 ends as calls do: told raw, then by the stream.
  r.handle.script = async function* (h) {
    yield { type: "tool_call", name: "Read", toolUseId: "call_0", input: { file_path: "a" } };
    tell(h, { type: "tool_result", toolUseId: "call_0", content: "OLD CONTENT", isError: false });
    yield { type: "tool_result", toolName: "Read", toolUseId: "call_0", content: "OLD CONTENT", isError: false };
    yield result(h.id);
  };
  await turn(r.session, r.sink, "read it");
  // A newer call_0, announced as Droid announces a call (its message's tool_use), which the turn ends under with no result.
  r.handle.script = async function* (h) {
    tell(h, { type: "create_message", message: { id: "m2", role: "assistant", createdAt: 1, updatedAt: 1,
      content: [{ type: "tool_use", id: "call_0", name: "Execute", input: { command: "sleep 30" } }] } });
    yield { type: "tool_call", name: "Execute", toolUseId: "call_0", input: { command: "sleep 30" } };
    yield result(h.id);
  };
  await turn(r.session, r.sink, "again");
  const rows = (await r.session.history()).filter((message) => message.role === "tool" && message.tool_call_id === "call_0");
  assert.equal(rows.length, 2);
  assert.ok(rows[1].role === "tool");
  assert.doesNotMatch(rows[1].content ?? "", /OLD CONTENT/);
  assert.match(rows[1].content ?? "", /turn ended before/);
});

/** What the provider's text events say, joined. */
function streamedTextOf(events: ProviderEvent[]): string {
  return events.flatMap((event) => event.type === "text" ? [event.text] : []).join("");
}

test("/compact Droid refuses while it runs a turn of its own keeps the process, which goes on with it (2026-10-27)", async (t) => {
  const r = await rig(t);
  r.handle.compactScript = async () => { throw new Error("Wait for the current turn to finish before compressing."); };
  const refused = await turn(r.session, r.sink, "/compact");
  assert.equal(refused.status, "error");
  assert.match(refused.type === "turn.end" ? refused.error ?? "" : "", /turn of its own/);
  assert.equal(r.handle.closed, 0, "the turn Droid runs is not stopped");
  assert.equal((await turn(r.session, r.sink, "next")).status, "complete");
  assert.equal(r.sdk.opens.length, 1, "no new process");
  assert.deepEqual(r.handle.prompts.map((prompt) => prompt.text), ["next"]);
});

test("/context reads the actual breakdown without sending a model prompt; a meter read failure cannot fail a reply", async (t) => {
  const r = await rig(t);
  r.handle.breakdown = ContextBreakdownResultSchema.parse({
    modelId: "small", modelDisplayName: "Small model", contextBudget: 1000, usedTokens: 100, freeTokens: 900,
    categories: [{ name: "Messages", tokens: 80, colorKey: "messages" }], skills: [], mcpServers: [], droids: [],
  });
  assert.equal((await turn(r.session, r.sink, "/context")).status, "complete");
  assert.equal(r.handle.prompts.length, 0);
  assert.match(r.sink.events.findLast((event) => event.type === "text")?.text ?? "", /Small model context \(estimated\)\n100 \/ 1000 tokens used, 900 free\.\nMessages: 80 tokens/);
  r.handle.getContextStats = async () => { throw new Error("not available"); };
  assert.equal((await turn(r.session, r.sink, "normal reply")).status, "complete");
  assert.equal(r.handle.prompts.length, 1);
});

for (const sameID of [true, false]) {
  test(`Droid compact swaps the ${sameID ? "same-ID" : "new-ID"} handle, keeps history and settings, and records its marker once`, async (t) => {
    const r = await rig(t);
    await r.session.setModel("large", "droid");
    await r.session.setMode("medium");
    const next = new Handle(sameID ? r.handle.id : "compacted-id", r.handle.cwd, r.handle.options);
    next.settings = { ...r.handle.settings };
    next.context = { ...next.context, used: 20 };
    r.sdk.contexts.set(next.id, next.cwd);
    let instructions: unknown;
    let told = false;
    r.handle.compactScript = async (params) => {
      instructions = params;
      // Droid answers first, and says it compacted after, to the session now the thread's (fixtures/droid/compact.jsonl).
      setTimeout(() => {
        next.notify({ params: { notification: { type: "session_compacted", summaryId: "summary-one", removedCount: 6 } } });
        told = true;
      }, 0);
      return { session: next, removedCount: 6 };
    };
    const compacted = await turn(r.session, r.sink, "/compact keep the decisions");
    assert.equal(compacted.status, "complete");
    await until(() => told);
    assert.deepEqual(instructions, { customInstructions: "keep the decisions" });
    assert.equal(r.handle.prompts.length, 0);
    assert.equal(r.handle.closed, 0, "do not close the old wrapper sharing its successor's process");
    assert.deepEqual(r.sink.events.filter((event) => event.type === "compacted"), [{ type: "compacted", trigger: "manual", tokensBefore: 100 }]);
    const saved = r.provider.store.read("thread");
    assert.equal(saved.session, next.id);
    assert.equal(saved.previousSession, sameID ? undefined : r.handle.id);
    assert.deepEqual(saved.formerSessions, sameID ? undefined : [r.handle.id]);
    assert.equal(saved.settings.model, "large");
    assert.equal(saved.mode, "medium");
    assert.deepEqual(saved.contextUsage, { used: 20, max: 1000, estimated: true });
    assert.equal(saved.messages.filter((message) => message.role === "compaction").length, 1);
    const mark = r.sink.events.length;
    r.handle.notify({ params: { notification: { type: "llm_retry", attempt: 9 } } });
    assert.equal(r.sink.events.length, mark, "detached source notifications cannot reach the new session");
    assert.equal((await turn(r.session, r.sink, "after compact")).status, "complete");
    assert.equal(next.prompts[0].text, "after compact");
    await r.session.close();
    const resumedSink = new Sink();
    const resumed = await r.provider.resumeSession(r.options(), resumedSink);
    assert.equal((await resumed.history()).filter((message) => message.role === "compaction").length, 1);
    await turn(resumed, resumedSink, "resume successor");
    assert.equal(r.sdk.opens.at(-1)?.id, next.id);
  });
}

test("a failed compact mapping write leaves the source resumable, not a silently invented session", async (t) => {
  const r = await rig(t);
  const next = new Handle("new-target", r.handle.cwd, r.handle.options);
  r.sdk.contexts.set(next.id, next.cwd);
  r.handle.compactScript = async () => ({ session: next, removedCount: 6 });
  const write = r.provider.store.write.bind(r.provider.store);
  let failed = false;
  r.provider.store.write = (state) => {
    if (!failed && state.session === next.id) { failed = true; throw new Error("disk unavailable"); }
    write(state);
  };
  const ended = await turn(r.session, r.sink, "/compact");
  assert.equal(ended.status, "error");
  assert.match(ended.error ?? "", /disk unavailable/);
  assert.equal(next.closed, 1);
  assert.equal(r.provider.store.read("thread").session, r.handle.id);
  assert.equal((await turn(r.session, r.sink, "continue source")).status, "complete");
  assert.equal(r.sdk.opens.at(-1)?.id, r.handle.id);
});

test("Droid keeps its saved source mapping when stopped mid-compact and closes a late successor", async (t) => {
  const r = await rig(t);
  const waiting = gate(), entered = gate();
  const next = new Handle("late-target", r.handle.cwd, r.handle.options);
  r.handle.compactScript = async () => { entered.resolve(); await waiting.promise; return { session: next, removedCount: 6 }; };
  r.session.startTurn({ text: "/compact", images: [] });
  await entered.promise;
  assert.equal(r.provider.store.read("thread").session, r.handle.id);
  await r.session.close();
  waiting.resolve();
  await until(() => next.closed === 1);
  assert.equal(r.provider.store.read("thread").session, r.handle.id);
  assert.equal(r.sink.events.filter((event) => event.type === "turn.end").length, 1);
  assert.equal(r.sink.events.filter((event) => event.type === "compacted").length, 0);
});

for (const outcome of ["finished", "stopped"] as const) test(`Stop during Droid's /compact stops only the compaction: the process stays, and a compaction that ${outcome === "finished" ? "finishes all the same is taken" : "Droid stops leaves the thread as it was"}`, async (t) => {
  const r = await rig(t);
  const waiting = gate(), entered = gate();
  const next = new Handle("compacted-id", r.handle.cwd, r.handle.options);
  r.sdk.contexts.set(next.id, next.cwd);
  r.handle.compactScript = async () => {
    entered.resolve();
    await waiting.promise;
    if (outcome === "stopped") throw new Error("Compaction was interrupted.");
    return { session: next, removedCount: 6 };
  };
  const mark = r.sink.events.length;
  r.session.startTurn({ text: "/compact", images: [] });
  await entered.promise;
  assert.equal(await r.session.interrupt(), true);
  // The turn ends at once, and Droid is asked to stop compacting without the process being stopped.
  assert.deepEqual(r.sink.events.slice(mark).filter((event) => event.type === "turn.end"), [{ type: "turn.end", status: "interrupted" }]);
  assert.equal(r.handle.interruptsAny, 1);
  // A message sent meanwhile waits for the compaction.
  const sent = r.sink.events.length;
  r.session.startTurn({ text: "after the stop", images: [] });
  await sleep(5);
  assert.equal(r.handle.prompts.length + next.prompts.length, 0);
  waiting.resolve();
  assert.equal((await r.sink.end(sent))[0]!.status, "complete");
  assert.equal(r.handle.closed, 0);
  assert.equal(next.closed, 0);
  assert.equal(r.sink.events.some((event) => event.type === "error"), false);
  if (outcome === "finished") {
    assert.equal(r.provider.store.read("thread").session, "compacted-id");
    assert.equal(r.sink.events.filter((event) => event.type === "compacted").length, 1);
    assert.equal(next.prompts.at(-1)?.text, "after the stop");
  } else {
    assert.equal(r.provider.store.read("thread").session, r.handle.id);
    assert.equal(r.sink.events.filter((event) => event.type === "compacted").length, 0);
    assert.equal(r.handle.prompts.at(-1)?.text, "after the stop");
  }
  assert.equal(r.sdk.opens.length, 1, "no new process");
  // What the turn that waited said is kept, also once the compaction replaced the thread's record.
  const kept = r.provider.store.read("thread").messages;
  assert.ok(kept.some((message) => message.role === "assistant" && message.text === "Reply: after the stop"));
  assert.deepEqual(kept.map((message) => message.role), outcome === "finished"
    ? ["user", "assistant", "user", "compaction", "assistant"] : ["user", "assistant", "user", "assistant"]);
});

for (const order of ["after", "before"] as const) test(`/compact whose word from Droid comes ${order} its answer records one marker, and Droid's own compaction after it is still recorded as automatic`, async (t) => {
  const r = await rig(t);
  const next = new Handle(r.handle.id, r.handle.cwd, r.handle.options);
  next.settings = { ...r.handle.settings };
  const compactedWord = (handle: Handle, summaryId: string) => handle.notify({ params: { notification: { type: "session_compacted", summaryId, removedCount: 6 } } });
  r.handle.compactScript = async () => {
    // After: as Droid 1.0 and 1.3 send it, some milliseconds after the answer. Before: one read in the same chunk as the answer.
    if (order === "before") compactedWord(r.handle, "manual-summary");
    return { session: next, removedCount: 6 };
  };
  assert.equal((await turn(r.session, r.sink, "/compact")).status, "complete");
  if (order === "after") compactedWord(next, "manual-summary");
  const triggers = () => r.sink.events.flatMap((event) => event.type === "compacted" ? [event.trigger] : []);
  const markers = () => r.provider.store.read("thread").messages.flatMap((message) => message.role === "compaction" ? [message.trigger] : []);
  assert.deepEqual(triggers(), ["manual"]);
  assert.deepEqual(markers(), ["manual"]);
  // Droid compacting by itself later is its own.
  compactedWord(next, "auto-summary");
  assert.deepEqual(triggers(), ["manual", "auto"]);
  await until(() => markers().length === 2);
  assert.deepEqual(markers(), ["manual", "auto"]);
});

test("automatic Droid compaction stores one marker and refreshes context without replacing the active handle", async (t) => {
  const r = await rig(t);
  r.handle.context = { ...r.handle.context, used: 30 };
  const notification = { params: { notification: { type: "session_compacted", summaryId: "auto-summary", removedCount: 7 } } };
  r.handle.notify(notification);
  r.handle.notify(notification);
  await until(() => r.provider.store.read("thread").contextUsage?.used === 30);
  assert.deepEqual(r.sink.events.filter((event) => event.type === "compacted"), [{ type: "compacted", trigger: "auto", tokensBefore: 100 }]);
  assert.equal(r.provider.store.read("thread").messages.filter((message) => message.role === "compaction").length, 1);
  assert.equal(r.handle.closed, 0);
});

test("Droid offers compact/context through the unchanged command path and sends estimate flags in every usage shape", async (t) => {
  const r = await rig(t);
  await r.session.close();
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const created = await client.call("session.create", { profile: "droid" }), id = created.session_id;
  const usage = { context_used: 100, context_max: 1000, context_estimated: true };
  assert.deepEqual(created.info.usage, usage);
  const catalog = await client.call("commands.catalog", { profile: "droid" });
  assert.ok(catalog.pairs.some(([name]: string[]) => name === "/compact"));
  assert.ok(catalog.pairs.some(([name]: string[]) => name === "/context"));
  assert.deepEqual(await client.call("command.dispatch", { session_id: id, name: "compact", arg: "keep decisions" }), { type: "send", message: "/compact keep decisions" });
  await client.call("prompt.submit", { session_id: id, text: "hello" });
  const completed = await client.nextEvent("message.complete", id);
  assert.deepEqual(completed.payload.usage, usage);
  assert.deepEqual(client.events(id).findLast((event) => event.type === "session.usage")?.payload, { usage });
  assert.deepEqual((await client.call("session.resume", { session_id: id })).info.usage, usage);
});

test("Droid cost persists observed cumulative spend, never sums thinking twice or substitutes per-turn usage", async (t) => {
  const r = await rig(t);
  assert.match(r.session.cost(), /Tokens: unknown\nFactory credits: unknown/);
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 10, thinkingTokens: 7, factoryCredits: 0.125 };
  r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "agent_turn_completed", cumulativeTokenUsage: usage } } });
  assert.match(r.session.cost(), /Tokens: 160\nFactory credits: 0.125/);
  r.handle.notify({ params: { sessionId: r.handle.id, notification: { type: "agent_turn_completed", tokenUsage: { inputTokens: 7, factoryCredits: 5 } } } });
  r.handle.notify({ params: { sessionId: "child", notification: { type: "session_token_usage_changed", tokenUsage: { inputTokens: 999, factoryCredits: 6 } } } });
  assert.match(r.session.cost(), /Tokens: 160\nFactory credits: 0.125/);
  await r.session.close();
  const reopened = await r.provider.resumeSession(r.options(), new Sink());
  const count = r.sdk.opens.length;
  assert.match(reopened.cost(), /Tokens: 160\nFactory credits: 0.125/);
  assert.equal(r.sdk.opens.length, count, "/cost does not warm a lazy saved session");
});

test("Droid command RPCs scope project catalogs to followed threads, expand privately, and execute cost and rename", async (t) => {
  const r = await rig(t);
  await r.session.close();
  const personal = join(r.home, ".factory", "commands");
  const project = join(r.directory, ".factory", "commands");
  mkdirSync(personal, { recursive: true }); mkdirSync(project, { recursive: true });
  writeFileSync(join(personal, "review.md"), "Personal review $ARGUMENTS");
  writeFileSync(join(project, "review.md"), "Private project template $ARGUMENTS; $ARGUMENTS");
  writeFileSync(join(project, "status.md"), "Must not replace bridge status");
  const open = r.sdk.open.bind(r.sdk);
  r.sdk.open = async (options, id) => {
    const handle = await open(options, id);
    handle.commands = { commands: [
      { name: "review", description: "Review changes", argumentHint: "[arguments]" },
      { name: "review", description: "Duplicate must not appear" }, { name: "status", description: "Must not replace status" },
      { name: "login", description: "Not allowed terminal command" },
    ] };
    return handle;
  };
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge), other = await TestClient.open(bridge);
  t.after(() => client.close()); t.after(() => other.close());
  const created = await client.call("session.create", { profile: "droid" }), id = created.session_id;
  const active = r.sdk.handles.at(-1)!;
  const projectCatalog = await client.call("commands.catalog", { profile: "droid", session_id: id });
  assert.deepEqual(projectCatalog.commands, { "/review": { source: "project", custom: true } });
  assert.equal(projectCatalog.pairs.filter(([name]: string[]) => name === "/review").length, 1);
  assert.equal(projectCatalog.pairs.filter(([name]: string[]) => name === "/status").length, 1);
  assert.equal(projectCatalog.pairs.some(([name]: string[]) => ["/login", "/new", "/model"].includes(name)), false);
  assert.equal(JSON.stringify(projectCatalog).includes("Private project template"), false);
  assert.deepEqual(projectCatalog.skills, {});
  const opens = r.sdk.opens.length;
  const privateCatalog = await client.call("commands.catalog", { profile: "droid" });
  assert.deepEqual(privateCatalog.commands, { "/review": { source: "user", custom: true } });
  assert.equal(r.sdk.opens.length, opens, "personal catalogs never create a temporary process or session");
  await assert.rejects(other.call("commands.catalog", { profile: "droid", session_id: id }), /not open/);
  await assert.rejects(client.call("commands.catalog", { profile: "fake", session_id: id }), /different agent/);
  await assert.rejects(client.call("slash.exec", { session_id: id, command: "/review carefully" }), /not one of/);
  assert.deepEqual(await client.call("command.dispatch", { session_id: id, name: "review", arg: "carefully" }), {
    type: "send", message: "Private project template carefully; carefully", display: "/review carefully",
  });
  assert.match((await client.call("slash.exec", { session_id: id, command: "/cost" })).output, /session spend, not account balance/);
  assert.match((await client.call("command.dispatch", { session_id: id, name: "rename", arg: "Command title" })).output, /Command title/);
  assert.deepEqual(active.titles, ["Command title"]);
  assert.equal((await client.call("session.resume", { session_id: id })).info.title, "Command title");
  await assert.rejects(client.call("command.dispatch", { session_id: id, name: "rename", arg: "  " }), /nonempty title/);
  assert.equal(active.prompts.length, 0, "display actions and expansion do not start an LLM turn");
});

test("Droid command catalogs never warm cold threads or create absent-thread sessions and retain per-cwd metadata", async (t) => {
  const r = await rig(t);
  const directory = join(r.directory, ".factory", "commands");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "review.md"), "Private prompt $ARGUMENTS");
  r.handle.commands = { commands: [{ name: "review", description: "Warm SDK description", argumentHint: "[scope]" }] };
  const thread = { id: "thread", cwd: r.options().cwd };
  const warm = await r.provider.commands(thread);
  assert.equal(warm.find((c) => c.name === "review")?.description, "Warm SDK description");
  await r.session.cool();
  const second = await r.provider.startSession(r.options("second"), new Sink());
  r.sdk.handles.at(-1)!.commands = { commands: [{ name: "review", description: "Another warm session, same cwd" }] };
  assert.equal((await r.provider.commands(thread)).find((c) => c.name === "review")?.description, "Another warm session, same cwd");
  await second.cool();
  const opens = r.sdk.opens.length;
  r.sdk.open = async () => { assert.fail("catalog must never open Droid"); };
  writeFileSync(join(directory, "fresh.md"), "New command");
  for (let n = 0; n < 2; n++) {
    const cold = await r.provider.commands(thread);
    assert.equal(cold.find((c) => c.name === "review")?.description, "Another warm session, same cwd");
    assert.equal(cold.find((c) => c.name === "fresh")?.description, "Project Markdown command");
    assert.deepEqual((await r.provider.commands()).map((c) => c.name), ["context", "compact", "skills", "mcp", "cost", "rename"]);
    // The commands the bridge runs itself are the ones slash.exec looks up.
    assert.deepEqual([...r.provider.executes], (await r.provider.commands()).filter((c) => c.execute).map((c) => c.name));
  }
  assert.equal(r.sdk.opens.length, opens);
});

test("each Droid thread's process is told which thread it is, for the portals command to say who sends, only where the bridge offers the command", async (t) => {
  for (const portals of [{ bin: "/portals/bin", instructions: "Use portals." }, undefined]) {
    const directory = mkdtempSync(join(tmpdir(), "portals-droid-test-"));
    const sdk = new Sdk();
    const provider = new DroidProvider({ command: "/not-a-real-droid", directory, idleMs: 100, maxWarm: 2, sdk, checkVersion: false, portals });
    t.after(async () => { await provider.close(); rmSync(directory, { recursive: true, force: true }); });
    await provider.models();
    await provider.startSession({ id: "thread-7", cwd: realpathSync(directory), settings: { model: "default", provider: "droid", reasoningEffort: "" } }, new Sink());
    assert.deepEqual(sdk.opens.at(-1)?.env, portals ? { PORTALS_THREAD: "thread-7" } : undefined);
  }
});

// MARK: Turns Droid begins by itself

/** A raw notification of the thread's own Droid session. */
function tell(h: Handle, notification: Record<string, unknown>): void {
  h.notify({ params: { sessionId: h.id, notification } });
}

const stamped = { createdAt: 1, updatedAt: 1 };

/** The turn Droid begins by itself to answer the completion `turnId`: it thinks, reads a file, and says `reply` in two pieces. */
function ownTurn(h: Handle, turnId: string, reply: string): void {
  tell(h, { type: "droid_working_state_changed", newState: "streaming_assistant_message" });
  tell(h, { type: "thinking_text_delta", messageId: "own-1", blockIndex: 0, textDelta: "Reading the report." });
  tell(h, { type: "create_message", message: { id: "own-1", role: "assistant", ...stamped, content: [
    { type: "thinking", thinking: "Reading the report.", signature: "s" },
    { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "notes.md" } }] } });
  tell(h, { type: "tool_result", messageId: "own-2", toolUseId: "read-1", content: "notes", isError: false });
  for (const piece of [reply.slice(0, 5), reply.slice(5)]) tell(h, { type: "assistant_text_delta", messageId: "own-3", blockIndex: 0, textDelta: piece });
  tell(h, { type: "create_message", message: { id: "own-3", role: "assistant", ...stamped, content: [{ type: "text", text: reply }] } });
  tell(h, { type: "agent_turn_completed", reason: "completed", turnId, durationMs: 4000,
    tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
  tell(h, { type: "droid_working_state_changed", newState: "idle" });
}

/** A turn that sets a worker to `description` in the background, and Droid's message when it ends. */
function backgroundTask(description: string) {
  const launch: Script = async function* (h) {
    yield { type: "tool_call", name: "Task", toolUseId: "task", input: { await: false, description, subagent_type: "worker" } };
    tell(h, { type: "child_session_available", toolUseId: "task", childSessionId: "child" });
    yield { type: "tool_result", toolUseId: "task", toolName: "Task", content: "Task launched in background.\ntask_id: child\nsession_id: child\nsubagent_type: worker", isError: false };
    yield { type: "assistant_text_delta", messageId: "ack", blockIndex: 0, text: "I'll write it up when the worker reports back." };
    yield result(h.id);
  };
  const done = { type: "create_message", message: { id: "task-completion:t1", role: "system", visibility: "llm_only", content: [{ type: "text",
    text: `Background task completed.\ntask_id: child\ntype: worker\nreason: completed\ndescription: ${description}\noutput: Final child report` }] } };
  return { launch, done };
}

test("the turn Droid begins by itself when a background worker ends reaches the app, saying why, and is kept (2026-10-26: the write-up never showed)", async (t) => {
  const r = await rig(t);
  await r.session.close();
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const { session_id } = await client.call("session.create", { profile: "droid" });
  const h = r.sdk.handles.at(-1)!;
  const task = backgroundTask("Research Hermes gateway sessions");
  h.script = task.launch;
  await client.call("prompt.submit", { session_id, text: "research it" });
  await client.nextEvent("message.complete", session_id);
  const session = [...(r.provider as unknown as { sessions: Set<DroidSession> }).sessions].find((open) => open.id === session_id)!;
  assert.equal(session.busy, true, "the worker holds the process");

  const start = client.events(session_id).length;
  tell(h, task.done);
  ownTurn(h, "task-completion:t1", "Here are the findings.");
  const done = await client.nextEvent("message.complete", session_id);
  const line = 'Agent "Research Hermes gateway sessions" finished';
  const events = client.events(session_id).slice(start).filter((event) => !event.type.startsWith("subagent."));
  assert.deepEqual(events.slice(0, 3).map((event) => [event.type, event.payload ?? null]), [
    ["status.update", { kind: "process", text: line }],
    ["thinking.delta", { text: "" }],
    ["message.start", null],
  ]);
  assert.equal(streamedText(events), "Here are the findings.");
  assert.equal(done.payload.status, "complete");
  assert.equal(done.payload.text, "Here are the findings.");
  assert.ok(events.some((event) => event.type === "tool.start" && event.payload.name === "read_file"));
  assert.equal(session.busy, false, "the worker's end and Droid's answer to it are over");

  // Opened again, the thread shows the line where a message of the user's would be, then the reply.
  const resumed = await client.call("session.resume", { session_id });
  const opener = resumed.messages.findLast((message: any) => message.role === "user");
  assert.deepEqual({ ...opener, timestamp: 0 }, { role: "user", text: line, timestamp: 0,
    display_kind: "async_delegation_complete", display_metadata: { display_text: line } });
  const last = resumed.messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.text, "Here are the findings.");
  assert.ok(resumed.messages.some((message: any) => message.role === "assistant" && message.reasoning === "Reading the report."), "its thought, kept before the tool");
  assert.deepEqual(last.turn_usage, { seconds: 4, tokens: 15 });
  assert.equal(resumed.messages.filter((message: any) => message.role === "assistant" && message.text === "Here are the findings.").length, 1);
});

for (const late of ["raw completion", "context read"] as const) test(`what Droid says after its turn for the message, while the app's turn still closes (${late}), is a turn of its own after it, and a message sent meanwhile waits for it`, async (t) => {
  const r = await rig(t);
  await r.session.close();
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]), config: { generalFolder: r.options().cwd } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const { session_id } = await client.call("session.create", { profile: "droid" });
  const h = r.sdk.handles.at(-1)!;
  const task = backgroundTask("Check the build");
  h.script = task.launch;
  await client.call("prompt.submit", { session_id, text: "launch" });
  await client.nextEvent("message.complete", session_id);

  // The next turn's reply ends, and Droid's own begins at once: in the same breath as its
  // completion (`raw completion`), or while the bridge reads the context afterwards.
  const reading = gate(), queued = gate();
  const contextStats = h.getContextStats.bind(h);
  let held = false;
  h.getContextStats = async () => {
    if (held) return contextStats();
    held = true;
    if (late === "context read") { tell(h, task.done); ownTurn(h, "task-completion:t1", "The build passed."); }
    reading.resolve();
    await queued.promise;
    return contextStats();
  };
  h.script = async function* (handle) {
    yield { type: "assistant_text_delta", messageId: "answer", blockIndex: 0, text: "Answered." };
    yield result(handle.id);
    if (late === "raw completion") {
      tell(handle, { type: "agent_turn_completed", reason: "completed", turnId: "turn-2" });
      tell(handle, task.done);
      ownTurn(handle, "task-completion:t1", "The build passed.");
    }
  };
  const start = client.events(session_id).length;
  await client.call("prompt.submit", { session_id, text: "question" });
  await reading.promise;
  // Sent while the turn closes: it waits for the turn Droid began by itself.
  assert.equal((await client.call("prompt.submit", { session_id, text: "next" })).status, "queued");
  h.script = null;
  queued.resolve();
  await until(() => client.events(session_id).slice(start).filter((event) => event.type === "message.complete").length === 3);
  const ends = client.events(session_id).slice(start).filter((event) => event.type === "message.complete").map((event) => event.payload.text);
  assert.deepEqual(ends, ["Answered.", "The build passed.", "Reply: next"]);
  assert.deepEqual(h.prompts.map((prompt) => prompt.text), ["launch", "question", "next"]);
  const resumed = await client.call("session.resume", { session_id });
  assert.deepEqual(resumed.messages.filter((message: any) => message.role !== "tool").map((message: any) => [message.role, message.display_kind ?? null, message.text]), [
    ["user", null, "launch"], ["assistant", null, "I'll write it up when the worker reports back."],
    ["user", null, "question"], ["assistant", null, "Answered."],
    // Its thought before the tool, then its reply.
    ["user", "async_delegation_complete", 'Agent "Check the build" finished'], ["assistant", null, ""], ["assistant", null, "The build passed."],
    ["user", null, "next"], ["assistant", null, "Reply: next"],
  ]);
});

test("Droid's own turn: Stop interrupts it, and the trailing notices of a turn already ended open none", async (t) => {
  const r = await rig(t);
  await turn(r.session, r.sink, "reply");
  // Only Droid's state and its turn's end, after the turn: nothing said, no turn.
  const mark = r.sink.events.length;
  tell(r.handle, { type: "droid_working_state_changed", newState: "streaming_assistant_message" });
  tell(r.handle, { type: "agent_turn_completed", reason: "completed", turnId: "turn-1" });
  tell(r.handle, { type: "droid_working_state_changed", newState: "idle" });
  assert.deepEqual(r.sink.events.slice(mark).filter((event) => event.type === "turn.begin" || event.type === "turn.end"), []);

  tell(r.handle, { type: "assistant_text_delta", messageId: "own", blockIndex: 0, textDelta: "Working on" });
  assert.deepEqual(r.sink.events.slice(mark).find((event) => event.type === "turn.begin"), { type: "turn.begin", user: "", host: { kind: "hidden", text: "" } });
  assert.equal(r.session.busy, true);
  assert.equal(await r.session.interrupt(), true);
  assert.equal(r.handle.interrupted, true);
  tell(r.handle, { type: "agent_turn_completed", reason: "cancelled", turnId: "own-turn" });
  const [end] = await r.sink.end(mark);
  assert.equal(end.status, "interrupted");
  assert.equal(r.session.busy, false);
  const history = await r.session.history();
  assert.deepEqual(history.slice(-3).map((message) => [message.role, "text" in message ? message.text : null]), [["user", ""], ["assistant", "Working on"], ["assistant", ""]]);
  const stop = history.at(-1)!;
  assert.deepEqual(stop.role === "assistant" ? stop.display_metadata : undefined, { interrupted: true });
});

test("a desk session continued in Portals is Portals' own thread once it has loaded: a later cold open is not refused for Portals' own unfinished calls or an open Factory app (PR #19 review B2)", async (t) => {
  let processes: DroidProcess[] = [];
  const r = await rig(t, { processes: async () => processes });
  const cwd = realpathSync(r.directory);
  const id = "8c1f4f8e-3a5e-4c1e-9d0e-2f6a1b7c9d01";
  const folder = join(r.home, ".factory", "sessions", cwd.replaceAll("/", "-"));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id}.jsonl`);
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  writeFileSync(path, line({ type: "session_start", id, cwd, title: "From the CLI" }) +
    line({ type: "message", id: "m1", timestamp: "2026-10-29T12:00:00Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } }));
  r.sdk.contexts.set(id, cwd);
  const adopted = await r.provider.adopt(id, "continue");
  const options = { ...r.options(id), settings: adopted.settings };
  const first = await r.provider.resumeSession(options, new Sink());
  await first.initialize();
  await first.close();
  // A turn of Portals' own ran Execute, and the bridge stopped mid-call; the Factory app is open now.
  writeFileSync(path, readFileSync(path, "utf8") +
    line({ type: "message", id: "m2", timestamp: "2026-10-29T12:01:00Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Execute", input: { command: "sleep 100" } }] } }) +
    line({ type: "message", id: "m3", timestamp: "2026-10-29T12:01:00Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "__TOOL_RESULT_PENDING__" }] } }));
  processes = [{ pid: 2, command: "/Applications/Factory.app/Contents/Resources/bin/droid", args: "droid daemon --listen ipc" }];
  const opens = r.sdk.opens.length;
  const again = await r.provider.resumeSession(options, new Sink());
  await again.initialize();
  assert.equal(r.sdk.opens.length, opens + 1);
  assert.equal(r.sdk.opens.at(-1)!.id, id);
});
