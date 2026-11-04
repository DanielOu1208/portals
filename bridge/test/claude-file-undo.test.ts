import "./environment.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { claudeVersion, verifyClaudeLaunch } from "../src/providers/claude/options.ts";
import { ClaudeProvider } from "../src/providers/claude/provider.ts";
import type { ClaudeSession, QueryLike } from "../src/providers/claude/session.ts";
import type { FileRewindResult, ProviderEvent } from "../src/providers/types.ts";
import { FakeFiles, FakeQuery } from "./claude-fixtures.ts";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "claude-file-undo-")));
after(() => rmSync(cwd, { recursive: true, force: true }));
const settings = { model: "sonnet", provider: "anthropic", reasoningEffort: "high" };
const user = (uuid: string) => ({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content: "duplicate" } });
const assistant = (uuid: string) => ({ type: "assistant", uuid, parent_tool_use_id: null, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
const history = () => [user("first"), assistant("first-end"), user("latest"), user("steer"), assistant("latest-end")];

type RewindCall = { id: string; dryRun: boolean };
interface Setup {
  path?: string;
  files?: FakeFiles;
  seed?: boolean;
  snapshots?: boolean;
  supported?: boolean;
  nativeVersion?: string | null;
  claudePath?: string;
  emitInit?: boolean;
  launchVersion?: (path: string) => Promise<string | null>;
  onQuery?: (query: FakeQuery) => void;
  rewind?: (call: RewindCall) => Promise<FileRewindResult>;
}

async function setup(options: Setup = {}) {
  const files = options.files ?? new FakeFiles();
  if (!options.files) {
    files.started.push({ sessionId: "source", summary: "Source", cwd, lastModified: 1 });
    files.stored.set("source", { title: "Source", messages: history() });
  }
  const queries: FakeQuery[] = [];
  const calls: RewindCall[] = [];
  const provider = new ClaudeProvider({
    settings: { path: options.claudePath ?? "/nonexistent/claude", folder: cwd, idleMinutes: 15, maxWarm: 6, apiKey: null },
    files,
    checkpointPath: options.path,
    launchVersion: options.launchVersion,
    agents: async () => [],
    env: { PATH: "/usr/bin", HOME: "/nonexistent/home" },
    managedSettings: "/nonexistent/managed-settings.json",
    query(input, nativeOptions): QueryLike {
      const query = new FakeQuery(input, nativeOptions);
      queries.push(query);
      if (options.emitInit !== false) query.emit({ type: "system", subtype: "init", claude_code_version: options.nativeVersion === undefined ? "2.1.318" : options.nativeVersion, model: "sonnet", session_id: "source" });
      options.onQuery?.(query);
      if (options.supported === false) return query;
      return Object.assign(query, { async rewindFiles(id: string, native: { dryRun: boolean }): Promise<FileRewindResult> {
        const call = { id, dryRun: native.dryRun };
        calls.push(call);
        return options.rewind ? options.rewind(call) : { canRewind: true, filesChanged: ["file.txt"], insertions: 1, deletions: 2 };
      } });
    },
  });
  if (options.seed !== false) {
    for (const [opener, end] of [["first", "first-end"], ["latest", "latest-end"]]) {
      provider.checkpoints.sent("source", opener, false, options.snapshots !== false);
      if (opener === "latest") provider.checkpoints.sent("source", "steer", true);
      provider.checkpoints.observed("source", assistant(end));
      provider.checkpoints.finish("source");
    }
  }
  const events: ProviderEvent[] = [];
  const session = await provider.resumeSession({ id: "source", cwd, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "interrupted" }) }) as ClaudeSession;
  return { provider, session, files, queries, calls, events };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Claude file undo previews and restores through a resumed idle query without a prompt or conversation truncation", async (t) => {
  const state = await setup();
  t.after(() => state.provider.close());
  const before = structuredClone(await state.files.messages("source"));
  const preview = await state.session.rewindFiles("latest", true);
  assert.deepEqual(preview, { canRewind: true, filesChanged: ["file.txt"], insertions: 1, deletions: 2 });
  assert.deepEqual(state.calls, [{ id: "latest", dryRun: true }]);
  assert.equal(state.queries.length, 1);
  assert.equal(state.queries[0].options.resume, "source");
  assert.equal(state.queries[0].options.enableFileCheckpointing, true);
  assert.equal(state.queries[0].received.length, 0);
  await state.session.rewindFiles("latest", false);
  assert.deepEqual(state.calls.map((call) => call.dryRun), [true, true, false]);
  assert.deepEqual(await state.files.messages("source"), before);
  assert.equal(state.queries[0].received.length, 0);
  await assert.rejects(state.session.rewindFiles("latest", false), /already been used/);
  await state.session.rewindFiles("latest", true);
  assert.deepEqual(state.calls.map((call) => call.dryRun), [true, true, false, true]);
});

test("file undo rejects unknown, steering, older, incomplete, active, background, and moved native sessions", async (t) => {
  const state = await setup();
  t.after(() => state.provider.close());
  for (const id of ["missing", "first", "steer"]) await assert.rejects(state.session.rewindFiles(id, true), /latest completed turn/);
  assert.equal(state.queries.length, 0);
  const messages = state.files.stored.get("source")!.messages;
  messages.push(user("unfinished"));
  await assert.rejects(state.session.rewindFiles("latest", true), /latest completed turn/);
  messages.pop();
  const moved = realpathSync(mkdtempSync(join(tmpdir(), "claude-undo-moved-")));
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  state.files.started[0].cwd = moved;
  await assert.rejects(state.session.rewindFiles("latest", true), /folder no longer matches/);
  state.files.started[0].cwd = cwd;
  await state.session.rewindFiles("latest", true);
  state.queries[0].emit({ type: "system", subtype: "task_started", task_id: "background", description: "Background work", is_backgrounded: true, task_type: "local_agent", uuid: "background-start", session_id: "source" });
  state.queries[0].emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "background", task_type: "local_agent", description: "Background work", status: "running" }], session_id: "source" });
  await until(() => state.session.hasBackgroundWork());
  await assert.rejects(state.session.rewindFiles("latest", false), /background work/);
  assert.equal(state.calls.length, 1);

  const active = await setup();
  t.after(() => active.provider.close());
  active.session.startTurn({ text: "new work", images: [] });
  await assert.rejects(active.session.rewindFiles("latest", true), /finish/);
  assert.equal(active.calls.length, 0);
});

test("missing SDK rewind support and old uncheckpointed histories never silently restore files", async (t) => {
  const unsupported = await setup({ supported: false });
  t.after(() => unsupported.provider.close());
  await assert.rejects(unsupported.session.rewindFiles("latest", true), /SDK does not support/);
  assert.equal(unsupported.queries[0].received.length, 0);
  const old = await setup({ snapshots: false });
  t.after(() => old.provider.close());
  assert.equal((await old.session.history()).some((row) => row.role === "user" && row.checkpoint?.can_undo_files), false);
  await assert.rejects(old.session.rewindFiles("latest", false), /latest completed turn/);
  assert.equal(old.queries.length, 0);
  const absent = await setup({ rewind: async () => ({ canRewind: false, error: "No file checkpoint found" }) });
  t.after(() => absent.provider.close());
  assert.deepEqual(await absent.session.rewindFiles("latest", false), { canRewind: false, error: "No file checkpoint found" });
  assert.deepEqual(absent.calls, [{ id: "latest", dryRun: true }]);
});

test("native partial/link safety results remain explicit and cannot be replayed destructively", async (t) => {
  const state = await setup({ rewind: async ({ dryRun }) => dryRun ? { canRewind: true, filesChanged: ["linked.txt"], insertions: 3, deletions: 4 } : { canRewind: true, filesChanged: ["linked.txt"], skippedLinks: 1 } });
  t.after(() => state.provider.close());
  assert.deepEqual(await state.session.rewindFiles("latest", false), { canRewind: true, filesChanged: ["linked.txt"], skippedLinks: 1 });
  await assert.rejects(state.session.rewindFiles("latest", false), /already been used/);
  assert.deepEqual(await state.session.rewindFiles("latest", true), { canRewind: true, filesChanged: ["linked.txt"], insertions: 3, deletions: 4 });
  assert.equal(state.provider.checkpoints.canUndoFiles("source", "latest", await state.files.messages("source")), false);
  assert.equal(state.calls.filter((call) => !call.dryRun).length, 1);
});

test("an ambiguous native restore failure consumes eligibility, and overlapping previews never issue a second native call", async (t) => {
  const failed = await setup({ rewind: async ({ dryRun }) => {
    if (!dryRun) throw new Error("connection lost after restore request");
    return { canRewind: true, filesChanged: ["file.txt"] };
  } });
  t.after(() => failed.provider.close());
  await assert.rejects(failed.session.rewindFiles("latest", false), /connection lost/);
  await assert.rejects(failed.session.rewindFiles("latest", false), /already been used/);
  assert.equal(failed.provider.checkpoints.canUndoFiles("source", "latest", await failed.files.messages("source")), false);
  let release: ((result: FileRewindResult) => void) | undefined;
  const waiting = await setup({ rewind: () => new Promise((resolve) => { release = resolve; }) });
  t.after(() => waiting.provider.close());
  const preview = waiting.session.rewindFiles("latest", true);
  await until(() => release !== undefined);
  await assert.rejects(waiting.session.rewindFiles("latest", true), /finish/);
  assert.equal(waiting.calls.length, 1);
  release!({ canRewind: true, filesChanged: [] });
  await preview;
});

test("new checkpoint-enabled turns persist eligibility on the real opener, including accepted steers, and only the latest turn advertises it", async (t) => {
  const path = join(cwd, "capabilities.json");
  const state = await setup({ path });
  t.after(() => state.provider.close());
  state.session.startTurn({ text: "new turn", images: [] });
  await until(() => state.queries.some((query) => query.received.length === 1));
  const query = state.queries.find((query) => query.received.length === 1)!;
  await state.session.steer({ text: "steer", images: [] });
  await query.waitForMessages(2);
  const opener = query.received[0].uuid!;
  const steer = query.received[1].uuid!;
  state.files.stored.get("source")!.messages.push(user(opener), user(steer), assistant("new-end"));
  query.emit(assistant("new-end"));
  query.emit({ type: "result", subtype: "success", is_error: false, user_message_uuids: [opener, steer], usage: {}, session_id: "source" });
  await until(() => state.events.some((event) => event.type === "turn.end"));
  const checkpoint = state.events.find((event) => event.type === "checkpoint");
  assert.equal(checkpoint?.type === "checkpoint" && checkpoint.checkpoint.id, opener);
  assert.equal(checkpoint?.type === "checkpoint" && checkpoint.checkpoint.can_undo_files, true);
  const recreated = await setup({ files: state.files, path, seed: false });
  t.after(() => recreated.provider.close());
  const eligible = (await recreated.session.history()).filter((row) => row.role === "user" && row.checkpoint?.can_undo_files);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].role === "user" && eligible[0].checkpoint?.id, opener);
  await assert.rejects(recreated.session.rewindFiles(steer, true), /latest completed turn/);
  await recreated.session.rewindFiles(opener, false);
  const consumed = await setup({ files: state.files, path, seed: false });
  t.after(() => consumed.provider.close());
  assert.equal((await consumed.session.history()).some((row) => row.role === "user" && row.checkpoint?.can_undo_files), false);
});

test("existing sidecar records and native forks without copied backups never claim file undo", async (t) => {
  const path = join(cwd, "old-capabilities.json");
  writeFileSync(path, JSON.stringify([{ session: "source", opener: "latest", sent: ["latest", "steer"], after: "latest-end" }]));
  const old = await setup({ path, seed: false });
  t.after(() => old.provider.close());
  assert.equal((await old.session.history()).some((row) => row.role === "user" && row.checkpoint?.can_undo_files), false);
  const state = await setup();
  t.after(() => state.provider.close());
  const source = await state.files.messages("source");
  const copied = structuredClone(source).map((raw) => ({ ...(raw as Record<string, unknown>), uuid: `copied-${(raw as { uuid: string }).uuid}` }));
  state.provider.checkpoints.copied("source", "fork", source, copied);
  const capabilities = state.provider.checkpoints.forSession("fork", copied);
  assert.equal(capabilities.get("copied-latest")?.can_fork, true);
  assert.equal(capabilities.get("copied-latest")?.can_undo_files, undefined);
});

test("old and unknown active-query versions refuse even a dry-run before any native rewind call", async (t) => {
  for (const nativeVersion of [null, "unknown", "2.1.317", "2.1.318-preview", "v2.1.318", "02.1.318"]) {
    const state = await setup({ nativeVersion });
    t.after(() => state.provider.close());
    await assert.rejects(state.session.rewindFiles("latest", true), /query to report version 2.1.318 or newer/);
    await assert.rejects(state.session.rewindFiles("latest", false), /query to report version 2.1.318 or newer/);
    assert.equal(state.calls.length, 0);
    assert.equal(state.queries.length, 1);
    assert.equal(state.queries[0].received.length, 0);
  }
});

test("a changed live query version is rechecked after preview before a real restore", async (t) => {
  const state = await setup({ rewind: async () => {
    state.queries[0].emit({ type: "system", subtype: "init", claude_code_version: "2.1.317", model: "sonnet", session_id: "source" });
    await new Promise((resolve) => setImmediate(resolve));
    return { canRewind: true, filesChanged: ["file.txt"] };
  } });
  t.after(() => state.provider.close());
  await assert.rejects(state.session.rewindFiles("latest", false), /query to report version 2.1.318 or newer/);
  assert.deepEqual(state.calls, [{ id: "latest", dryRun: true }]);
});

for (const status of ["error", "interrupted"] as const) {
  test(`an ${status} turn retains its native branch boundary but never offers or executes file undo`, async (t) => {
    const path = join(cwd, `ended-${status}.json`);
    const state = await setup({ path });
    t.after(() => state.provider.close());
    state.session.startTurn({ text: "work that does not complete", images: [] });
    await until(() => state.queries.some((query) => query.received.length === 1));
    const query = state.queries.find((query) => query.received.length === 1)!;
    const opener = query.received[0].uuid!;
    if (status === "interrupted") assert.equal(await state.session.interrupt(), true);
    const tail = assistant(`ended-${status}`);
    state.files.stored.get("source")!.messages.push(user(opener), tail);
    query.emit(tail);
    query.emit({
      type: "result", subtype: "error_during_execution", is_error: true,
      errors: [status === "interrupted" ? "Execution was interrupted" : "Execution failed after producing output"],
      ...(status === "interrupted" ? { terminal_reason: "aborted_streaming" } : {}),
      user_message_uuids: [opener], usage: {}, session_id: "source",
    });
    await until(() => state.events.some((event) => event.type === "turn.end"));
    const ended = state.events.find((event) => event.type === "turn.end");
    assert.equal(ended?.type === "turn.end" && ended.status, status);
    const checkpoint = state.events.find((event) => event.type === "checkpoint");
    assert.equal(checkpoint?.type === "checkpoint" && checkpoint.checkpoint.id, opener);
    assert.equal(checkpoint?.type === "checkpoint" && checkpoint.checkpoint.can_edit, true);
    assert.equal(checkpoint?.type === "checkpoint" && checkpoint.checkpoint.can_fork, true);
    assert.equal(checkpoint?.type === "checkpoint" && checkpoint.checkpoint.can_undo_files, undefined);

    // The restriction survives a provider restart, while ordinary branch actions remain.
    const recreated = await setup({ path, files: state.files, seed: false });
    t.after(() => recreated.provider.close());
    const row = (await recreated.session.history()).find((message) => message.role === "user" && message.checkpoint?.id === opener);
    assert.equal(row?.role === "user" && row.checkpoint?.can_edit, true);
    assert.equal(row?.role === "user" && row.checkpoint?.can_fork, true);
    assert.equal(row?.role === "user" && row.checkpoint?.can_undo_files, undefined);
    for (const session of [state.session, recreated.session]) {
      await assert.rejects(session.rewindFiles(opener, true), /latest completed turn/);
      await assert.rejects(session.rewindFiles(opener, false), /latest completed turn/);
    }
    assert.equal(state.calls.length, 0);
    assert.equal(recreated.calls.length, 0);
    assert.equal(query.received.length, 1);
  });
}

let launchFixture = 0;
/** Header stand-ins are never executed: the version probe and SDK query are both controlled. */
function nativeStandIn(): string {
  const path = join(cwd, `native-${++launchFixture}`);
  writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]), { mode: 0o700 });
  return path;
}

function changeNative(path: string): void {
  writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4, 5]));
}

test("a cold idle query can preview using proof of the exact native launch without receiving init or sending a prompt", async (t) => {
  const executable = nativeStandIn();
  const configured = `${executable}-configured`;
  symlinkSync(executable, configured);
  const probed: string[] = [];
  const state = await setup({ claudePath: configured, emitInit: false, launchVersion: async (path) => {
    probed.push(path);
    return "2.1.318";
  } });
  t.after(() => state.provider.close());
  await state.session.rewindFiles("latest", true);
  assert.deepEqual(probed, [realpathSync(executable)]);
  assert.equal(state.queries[0].options.pathToClaudeCodeExecutable, realpathSync(executable));
  assert.deepEqual(state.calls, [{ id: "latest", dryRun: true }]);
  assert.equal(state.queries[0].received.length, 0);
  await state.session.rewindFiles("latest", true);
  assert.equal(probed.length, 1);
  assert.equal(state.queries.length, 1);
});

test("changed native identity during version probing or after SDK handoff refuses before preview", async (t) => {
  const duringProbe = nativeStandIn();
  const probing = await setup({ claudePath: duringProbe, emitInit: false, launchVersion: async () => {
    changeNative(duringProbe);
    return "2.1.318";
  } });
  t.after(() => probing.provider.close());
  await assert.rejects(probing.session.rewindFiles("latest", true), /executable changed/);
  assert.equal(probing.queries.length, 0);
  assert.equal(probing.calls.length, 0);

  const duringLaunch = nativeStandIn();
  const launched = await setup({ claudePath: duringLaunch, emitInit: false, launchVersion: async () => "2.1.318", onQuery: () => changeNative(duringLaunch) });
  t.after(() => launched.provider.close());
  await assert.rejects(launched.session.rewindFiles("latest", true), /executable changed/);
  assert.equal(launched.queries.length, 1);
  assert.equal(launched.calls.length, 0);
  assert.equal(launched.queries[0].received.length, 0);
});

test("a current-query init overrides a supported launch proof, including explicit unknown and older versions", async (t) => {
  for (const nativeVersion of [null, "2.1.317", "2.1.318-preview"]) {
    const state = await setup({ claudePath: nativeStandIn(), nativeVersion, launchVersion: async () => "2.1.318" });
    t.after(() => state.provider.close());
    await assert.rejects(state.session.rewindFiles("latest", true), /query to report version 2.1.318 or newer/);
    assert.equal(state.calls.length, 0);
    assert.equal(state.queries[0].received.length, 0);
  }
});

test("launch proof is reprobed for a new query and never borrowed by an already existing unproved query", async (t) => {
  const executable = nativeStandIn();
  let version = "2.1.318";
  let probes = 0;
  const state = await setup({ claudePath: executable, emitInit: false, launchVersion: async () => { probes += 1; return version; } });
  t.after(() => state.provider.close());
  await state.session.rewindFiles("latest", true);
  await state.session.cool();
  version = "2.1.317";
  changeNative(executable);
  await assert.rejects(state.session.rewindFiles("latest", true), /query to report version 2.1.318 or newer/);
  assert.equal(probes, 2);
  assert.equal(state.queries.length, 2);
  assert.equal(state.calls.length, 1);

  const missing = join(cwd, "not-yet-installed");
  let unexpectedProbes = 0;
  const existing = await setup({ claudePath: missing, nativeVersion: null, launchVersion: async () => { unexpectedProbes += 1; return "2.1.318"; } });
  t.after(() => existing.provider.close());
  await assert.rejects(existing.session.rewindFiles("latest", true), /query to report version 2.1.318 or newer/);
  writeFileSync(missing, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o700 });
  await assert.rejects(existing.session.rewindFiles("latest", true), /query to report version 2.1.318 or newer/);
  assert.equal(existing.queries.length, 1);
  assert.equal(unexpectedProbes, 0);
  assert.equal(existing.calls.length, 0);
});

test("scripts cannot provide native launch proof, and strict version probes do not strip prerelease suffixes", async () => {
  const script = join(cwd, "version-script");
  writeFileSync(script, "#!/bin/sh\nprintf '2.1.318-preview (Claude Code)\\n'\n", { mode: 0o700 });
  let probed = false;
  assert.equal(await verifyClaudeLaunch(script, async () => { probed = true; return "2.1.318"; }), undefined);
  assert.equal(probed, false);
  assert.equal(await claudeVersion(script, { PATH: "/usr/bin" }, true), null);
  const nativeWithJsSuffix = `${nativeStandIn()}.js`;
  writeFileSync(nativeWithJsSuffix, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o700 });
  chmodSync(nativeWithJsSuffix, 0o700);
  assert.equal(await verifyClaudeLaunch(nativeWithJsSuffix, async () => { probed = true; return "2.1.318"; }), undefined);
  assert.equal(probed, false);
});
