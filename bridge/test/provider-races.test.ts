import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderSession, SubagentInfo } from "../src/providers/types.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { Session } from "../src/sessions/session.ts";
import { fakeClaude, play } from "./claude-fixtures.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const nextStep = () => new Promise<void>((resolve) => setImmediate(resolve));
const settings = { model: "sonnet", provider: "anthropic", reasoningEffort: "high" };

function session(id: string, choices = settings): Session {
  const record: ThreadRecord = { id, agent: "stand-in", cwd: "/tmp", title: "Audit", ...choices, createdAt: 0, updatedAt: 0, origin: "phone" };
  return new Session(record, { has: () => false } as unknown as Registry);
}

async function claude(id: string) {
  const core = session(id);
  const fake = fakeClaude({ titleWatchMs: [] });
  const adapter = await fake.provider.startSession({ id, cwd: "/tmp", title: "Audit", settings }, core.sink);
  await core.attach(adapter);
  core.submit("first").begin?.();
  await nextStep();
  const query = fake.queries.at(-1)!;
  await query.waitForMessages(1);
  return { core, adapter, query, queries: fake.queries, close: async () => { await core.close(); await fake.provider.close(); } };
}

for (const check of ["history", "terminal"] as const) test(`closing Claude during its startup ${check} check does not launch a query afterwards`, async () => {
  const core = session("startup-close");
  const entered = gate(), release = gate();
  const fake = fakeClaude({
    titleWatchMs: [],
    agents: check === "terminal" ? async () => { entered.resolve(); await release.promise; return []; } : undefined,
  });
  let historyChecks = 0;
  fake.files.exists = async () => {
    historyChecks += 1;
    if (check === "history") { entered.resolve(); await release.promise; }
    return false;
  };
  const adapter = await fake.provider.startSession({ id: core.id, cwd: "/tmp", title: "Audit", settings, desk: check === "terminal" }, core.sink);
  await core.attach(adapter);
  try {
    core.submit("do not send after closing").begin?.();
    await entered.promise;
    const closing = core.close();
    release.resolve();
    await closing;
    await nextStep();
    assert.equal(historyChecks, check === "history" ? 1 : 0);
    assert.equal(fake.queries.length, 0, "the startup check belongs to the closed session");
  } finally { release.resolve(); await core.close(); await fake.provider.close(); }
});

test("Claude applies every deferred control before a queued prompt reaches its query", async () => {
  const { core, adapter, query, close } = await claude("deferred-order");
  const release = gate();
  const sent = gate();
  const calls: string[] = [];
  query.setModel = async () => { calls.push("model"); sent.resolve(); await release.promise; };
  query.applyFlagSettings = async () => { calls.push("effort"); };
  query.setMaxThinkingTokens = async () => { calls.push("thinking"); };
  query.onMessage = () => { calls.push("prompt"); };
  try {
    await adapter.setModel!("haiku", "anthropic");
    await adapter.setReasoning!("low");
    core.submit("second", { queue: true });
    await play(query, "plain");
    await sent.promise;
    await nextStep();
    assert.equal(query.received.length, 1);
    release.resolve();
    await query.waitForMessages(2);
    assert.deepEqual(calls, ["model", "thinking", "effort", "thinking", "prompt"]);
  } finally { release.resolve(); await close(); }
});

for (const idle of [false, true]) test(`Claude permission changes finish before ${idle ? "a new turn" : "steering"} reaches native input`, async () => {
  const { core, adapter, query, close } = await claude(`permission-wait-${idle}`);
  const release = gate(), entered = gate();
  let changing: Promise<void> | undefined, steering: Promise<boolean | "refused"> | undefined;
  let applied = "bypassPermissions";
  const policies: string[] = [];
  try {
    await adapter.setMode!("full");
    if (idle) await play(query, "plain");
    query.setPermissionMode = async (mode) => { entered.resolve(); await release.promise; applied = mode; };
    query.onMessage = () => { policies.push(applied); };
    changing = adapter.setMode!("ask");
    await entered.promise;
    if (idle) core.submit("must ask").begin?.();
    else steering = adapter.steer!({ text: "must ask", images: [] });
    await nextStep();
    assert.equal(query.received.length, 1);
    release.resolve();
    await changing;
    await steering;
    await query.waitForMessages(2);
    assert.deepEqual(policies, ["default"]);
  } finally { release.resolve(); await changing; await steering; await close(); }
});

for (const idle of [false, true]) test(`Claude permission failure blocks ${idle ? "a new turn" : "steering"} until an explicit mode retry succeeds`, async () => {
  const { core, adapter, query, close } = await claude(`permission-refused-${idle}`);
  const release = gate(), entered = gate();
  let changing: Promise<unknown> | undefined;
  try {
    await adapter.setMode!("full");
    if (idle) await play(query, "plain");
    query.setPermissionMode = async () => { entered.resolve(); await release.promise; throw new Error("Refused permission request"); };
    changing = adapter.setMode!("ask").catch((error: unknown) => error);
    await entered.promise;
    core.submit("must not run with Full").begin?.();
    await nextStep();
    release.resolve();
    assert.match(String(await changing), /Refused permission request/);
    await nextStep();
    assert.equal(query.received.length, 1);
    if (!idle) {
      assert.equal(core.isRunning, true, "a refused steer must leave the original native turn running");
      await play(query, "plain");
      await nextStep();
      assert.ok(core.messages.some((message) => message.role === "assistant" && message.text.includes("Hello!")), "the original native reply remains visible");
    }
    assert.equal(core.isRunning, false);
    assert.match(JSON.stringify(core.snapshot()), /Refused permission request/);

    core.submit("still blocked").begin?.();
    await nextStep();
    assert.equal(query.received.length, 1);
    assert.equal(core.isRunning, false);
    query.setPermissionMode = async () => {};
    await adapter.setMode!("ask");
    core.submit("retry after Ask applied").begin?.();
    await query.waitForMessages(2);
    assert.equal(query.received[1].message.content, "retry after Ask applied");
  } finally { release.resolve(); await changing; await close(); }
});

test("Claude still accepts Stop for the native turn after refusing a steer on permission failure", async () => {
  const { core, adapter, query, close } = await claude("permission-refused-stop");
  try {
    await adapter.setMode!("full");
    query.setPermissionMode = async () => { throw new Error("Refused Ask"); };
    await assert.rejects(adapter.setMode!("ask"), /Refused Ask/);
    assert.equal(await adapter.steer!({ text: "must not reach Full", images: [] }), "refused");
    assert.equal(core.isRunning, true);
    assert.equal(await core.interrupt(), true);
    assert.ok(query.calls.some(([method]) => method === "interrupt"));
    assert.equal(query.received.length, 1);
  } finally { await close(); }
});

test("Claude permission changes serialize overlapping native updates before the next prompt", async () => {
  const { core, adapter, query, close } = await claude("permission-overlap");
  const release = gate(), entered = gate(), releaseNext = gate(), enteredNext = gate();
  const calls: string[] = [];
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  try {
    await adapter.setMode!("full");
    await play(query, "plain");
    query.setPermissionMode = async (mode) => {
      calls.push(mode);
      if (mode === "default") { entered.resolve(); await release.promise; }
      else { enteredNext.resolve(); await releaseNext.promise; }
    };
    first = adapter.setMode!("ask");
    await entered.promise;
    second = adapter.setMode!("edits");
    core.submit("after both choices").begin?.();
    await nextStep();
    assert.deepEqual(calls, ["default"]);
    assert.equal(query.received.length, 1);
    release.resolve();
    await enteredNext.promise;
    await nextStep();
    assert.equal(query.received.length, 1);
    releaseNext.resolve();
    await Promise.all([first, second]);
    await query.waitForMessages(2);
    assert.deepEqual(calls, ["default", "acceptEdits"]);
  } finally { release.resolve(); releaseNext.resolve(); await first; await second; await close(); }
});

test("a delayed Stop does not withdraw the next queued turn's Claude approval", async () => {
  const { core, query, close } = await claude("interrupt-order");
  const release = gate();
  query.interrupt = () => release.promise;
  try {
    core.submit("second", { queue: true });
    const stopping = core.interrupt(true);
    await play(query, "plain");
    await query.waitForMessages(2);
    let answered = false;
    const question = query.options.canUseTool!("Bash", { command: "echo second" }, {
      signal: new AbortController().signal, toolUseID: "second-tool", requestId: "second-tool", suggestions: [],
    }).then(() => { answered = true; });
    await Promise.resolve();
    const [approval] = core.requests.list();
    assert.ok(approval);
    release.resolve();
    await stopping;
    await nextStep();
    assert.equal(answered, false);
    assert.deepEqual(core.requests.list().map((request) => request.id), [approval.id]);
    core.requests.withdraw(approval.id, "test done");
    await question;
  } finally { release.resolve(); await close(); }
});

for (const idle of [false, true]) test(`Claude Stop begun ${idle ? "at rest" : "during a turn"} withdraws only its stopped worker's late question after another turn starts`, async () => {
  const { core, query, close } = await claude(`background-late-${idle}`);
  const release = gate(), stoppingTask = gate();
  core.follow({ isOpen: true, takesRequests: true, keepsSubagentRequests: true, sendRequest() {}, sendEvent() {} });
  for (const id of ["target", "not-stopped"]) {
    query.emit({ type: "system", subtype: "task_started", task_id: id, run_id: "one", task_type: "local_agent", is_backgrounded: true, description: id });
  }
  await nextStep();
  assert.equal(core.subagentList().length, 2);
  if (idle) await play(query, "plain");
  else core.submit("second", { queue: true });
  const stoppedIDs: string[] = [];
  query.stopTask = async (id) => { stoppedIDs.push(id); stoppingTask.resolve(); await release.promise; };
  const stopping = core.interrupt();
  const questions: Promise<unknown>[] = [];
  const ask = (toolUseID: string, agentID?: string) => {
    const question = query.options.canUseTool!("Bash", { command: toolUseID }, {
      signal: new AbortController().signal, toolUseID, requestId: toolUseID, ...(agentID ? { agentID } : {}),
    } as never);
    questions.push(Promise.resolve(question));
    return question;
  };
  try {
    await stoppingTask.promise;
    if (idle) core.submit("second").begin?.();
    else await play(query, "plain");
    await query.waitForMessages(2);
    const old = ask("old target late question", "target");
    let foregroundAnswered = false, untouchedAnswered = false, oldAnswered = false;
    void Promise.resolve(old).then(() => { oldAnswered = true; });
    void Promise.resolve(ask("new turn foreground")).then(() => { foregroundAnswered = true; });
    void Promise.resolve(ask("untouched old worker", "not-stopped")).then(() => { untouchedAnswered = true; });
    query.emit({ type: "system", subtype: "task_updated", task_id: "target", run_id: "one", patch: { status: "killed", end_time: Date.now() } });
    await nextStep();
    assert.equal(core.requests.list().length, 3);
    release.resolve();
    await stopping;
    await nextStep();
    assert.equal(oldAnswered, true);
    assert.equal((await old)?.behavior, "deny");
    assert.equal(foregroundAnswered, false);
    assert.equal(untouchedAnswered, false);
    assert.deepEqual(stoppedIDs, ["target"]);
    assert.deepEqual(core.requests.list().map((request) => request.params.command), ["new turn foreground", "untouched old worker"]);
  } finally {
    release.resolve();
    core.requests.withdrawAll("test done");
    await Promise.all(questions);
    await stopping;
    await close();
  }
});

test("a Stop the agent answers only after the next queued turn began still stops the stopped turn's background runs", async () => {
  const core = session("background-stop-late");
  const release = gate(), stopped: string[] = [];
  const questions: Promise<unknown>[] = [];
  const ask = (command: string, subagent?: string) => {
    questions.push(core.sink.ask(subagent ? { kind: "approval", command, subagent, choices: ["once", "deny"] } : { kind: "approval", command, choices: ["once", "deny"] }));
  };
  const provider: ProviderSession = {
    history: async () => [], settings: () => settings, startTurn() {}, close: async () => {},
    interrupt: async () => { await release.promise; return true; },
    setModel: async () => ({ deferred: false }), setReasoning: async () => {},
    stopSubagent: async (id) => { stopped.push(id); return true; },
  };
  const worker = (id: string): SubagentInfo => ({ id, run: "one", kind: "agent", goal: id, status: "running", startedAt: 1, background: true, stoppable: true });
  await core.attach(provider);
  // A device that keeps a subagent's card past the turn: the turn's end leaves its question open.
  core.follow({ isOpen: true, takesRequests: true, keepsSubagentRequests: true, sendRequest() {}, sendEvent() {} });
  core.submit("first").begin?.();
  core.sink.emit({ type: "subagent", subagent: worker("bg") });
  ask("background question", "bg");
  core.submit("second", { queue: true });
  // Stop, as `portals stop` sends it: the background goes with the turn.
  const stopping = core.interrupt(false);
  core.sink.emit({ type: "turn.end", status: "interrupted" });
  await nextStep();
  await nextStep();
  assert.equal(core.isRunning, true, "the queued message opened the next turn");
  ask("the next turn's own question");
  try {
    release.resolve();
    assert.equal(await stopping, true);
    assert.deepEqual(stopped, ["bg"]);
    assert.deepEqual(core.requests.list().map((request) => request.params.command), ["the next turn's own question"]);
  } finally {
    release.resolve();
    core.requests.withdrawAll("test done");
    await Promise.all(questions);
    await core.close();
  }
});

test("Claude drains a newer setting received while an older control is awaiting its reply", async () => {
  const { core, adapter, query, close } = await claude("deferred-newer");
  const release = gate(), sent = gate();
  const calls: string[] = [];
  query.setModel = async (model) => { calls.push(`model:${model}`); if (calls.length === 1) { sent.resolve(); await release.promise; } };
  query.setMaxThinkingTokens = async () => { calls.push("thinking"); };
  query.onMessage = () => { calls.push("prompt"); };
  try {
    await adapter.setModel("haiku", "anthropic");
    core.submit("second", { queue: true });
    await play(query, "plain");
    await sent.promise;
    await adapter.setModel("opus", "anthropic");
    release.resolve();
    await query.waitForMessages(2);
    assert.deepEqual(calls, ["model:haiku", "thinking", "model:opus", "thinking", "prompt"]);
  } finally { release.resolve(); await close(); }
});

test("a refused deferred Claude model does not discard an independent effort change", async () => {
  const { core, adapter, query, close } = await claude("deferred-refused");
  const calls: string[] = [];
  query.setModel = async () => { calls.push("model"); throw new Error("Refused stand-in model"); };
  query.applyFlagSettings = async () => { calls.push("effort"); };
  query.setMaxThinkingTokens = async () => { calls.push("thinking"); };
  query.onMessage = () => { calls.push("prompt"); };
  try {
    await adapter.setModel("haiku", "anthropic");
    await adapter.setReasoning("low");
    core.submit("second", { queue: true });
    await play(query, "plain");
    await query.waitForMessages(2);
    assert.deepEqual(calls, ["model", "effort", "thinking", "prompt"]);
  } finally { await close(); }
});

test("closing Claude while a deferred model awaits its reply sends neither thinking nor another prompt", async () => {
  const { core, adapter, query, close } = await claude("deferred-close");
  const release = gate(), sent = gate();
  const calls: string[] = [];
  query.setModel = async () => { calls.push("model"); sent.resolve(); await release.promise; };
  query.setMaxThinkingTokens = async () => { calls.push("thinking"); };
  query.onMessage = () => { calls.push("prompt"); };
  try {
    await adapter.setModel("haiku", "anthropic");
    core.submit("second", { queue: true });
    await play(query, "plain");
    await sent.promise;
    await core.close();
    release.resolve();
    await nextStep();
    assert.deepEqual(calls, ["model"]);
    assert.equal(query.received.length, 1);
  } finally { release.resolve(); await close(); }
});

test("a replacement Claude query does not wait for the dead query's pending control", async () => {
  const { core, adapter, query, queries, close } = await claude("deferred-replacement");
  const release = gate(), sent = gate();
  query.setModel = async () => { sent.resolve(); await release.promise; };
  try {
    await adapter.setModel("opus", "anthropic");
    core.submit("second", { queue: true });
    core.submit("third", { queue: true });
    await play(query, "plain");
    await sent.promise;
    query.close();
    await nextStep();
    await nextStep();
    const replacement = queries.at(-1)!;
    assert.notEqual(replacement, query);
    await nextStep();
    assert.equal(replacement.received.length, 1);
  } finally { release.resolve(); await close(); }
});

test("Stop snapshots background runs before awaiting the provider and skips a reused subagent id", async () => {
  const core = session("background-stop");
  const release = gate(), calls: string[] = [];
  const questions: Promise<unknown>[] = [];
  const ask = (command: string, subagent: string) => {
    questions.push(core.sink.ask({ kind: "approval", command, subagent, choices: ["once", "deny"] }));
  };
  const provider: ProviderSession = {
    history: async () => [], settings: () => settings, startTurn() {}, close: async () => {},
    interrupt: async () => { await release.promise; return true; },
    setModel: async () => ({ deferred: false }), setReasoning: async () => {},
    stopSubagent: async (id) => { calls.push(id); ask("old run during stop", id); return true; },
  };
  const worker = (id: string, run: string): SubagentInfo => ({ id, run, kind: "agent", goal: id, status: "running", startedAt: 1, background: true, stoppable: true });
  await core.attach(provider);
  core.submit("first").begin?.();
  core.sink.emit({ type: "subagent", subagent: worker("kept", "one") });
  core.sink.emit({ type: "subagent", subagent: worker("reused", "one") });
  core.sink.emit({ type: "subagent", subagent: worker("restarted", "one") });
  ask("captured old run", "reused");
  const stopping = core.interrupt();
  core.sink.emit({ type: "subagent", subagent: { ...worker("kept", "one"), summary: "progress meanwhile" } });
  core.sink.emit({ type: "subagent", subagent: worker("reused", "two") });
  core.sink.emit({ type: "subagent", subagent: { ...worker("restarted", "one"), startedAt: 2 } });
  core.sink.emit({ type: "subagent", subagent: worker("new", "one") });
  ask("old run while interrupt waits", "kept");
  ask("new run", "new");
  ask("reused run", "reused");
  ask("restarted run", "restarted");
  try {
    release.resolve();
    await stopping;
    assert.deepEqual(calls, ["kept"]);
    assert.deepEqual(core.requests.list().map((request) => request.params.command), ["new run", "reused run", "restarted run"]);
  } finally {
    release.resolve();
    core.requests.withdrawAll("test done");
    await Promise.all(questions);
    await core.close();
  }
});
