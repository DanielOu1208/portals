import "./environment.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BackgroundCommands } from "../src/providers/backgroundCommands.ts";
import type { ProviderEvent, SubagentInfo } from "../src/providers/types.ts";
import { EventLog } from "../src/sessions/eventLog.ts";
import type { Prompt, ProviderSession, SessionSink } from "../src/providers/types.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { Session, subagentPayload } from "../src/sessions/session.ts";

function rows(events: ProviderEvent[]): SubagentInfo[] {
  return events.flatMap((event) => (event.type === "subagent" ? [event.subagent] : []));
}

test("a command left running is a command row at work, its last line of output its summary, updated at most once an interval", async () => {
  const events: ProviderEvent[] = [];
  const commands = new BackgroundCommands((event) => events.push(event), { now: Date.now, intervalMs: 60 });
  commands.start("exec-1", { goal: "npm run dev", startedAt: 5, stoppable: true, output: "starting\n" });
  assert.deepEqual(rows(events), [{
    id: "exec-1", kind: "command", goal: "npm run dev", status: "running", startedAt: 5, background: true, stoppable: true,
    output: "starting\n", outputTruncated: false, summary: "starting",
  }]);
  for (let line = 1; line <= 20; line += 1) commands.append("exec-1", `ready ${line}\r\n`);
  assert.equal(rows(events).length, 1, "within an interval of its start, output waits");
  await sleep(120);
  assert.equal(rows(events).length, 2, "and goes out together, once");
  assert.equal(rows(events).at(-1)!.summary, "ready 20");
  commands.end("exec-1", "completed", { output: "starting\nready\nbye\n" });
  const last = rows(events).at(-1)!;
  assert.equal(last.status, "completed");
  assert.equal(last.stoppable, false);
  assert.equal(last.output, "starting\nready\nbye\n");
  assert.ok(last.endedAt !== undefined);
  // An ended command takes no more output.
  commands.append("exec-1", "late\n");
  await sleep(120);
  assert.equal(rows(events).at(-1), last);
});

test("a command's output file is read while it runs, only its end; a link is not read", { timeout: 10_000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "bg-commands-"));
  try {
    const file = join(folder, "b1.output");
    writeFileSync(file, "tick 1\n");
    const events: ProviderEvent[] = [];
    const ended = Promise.withResolvers<void>();
    const commands = new BackgroundCommands((event) => {
      events.push(event);
      if (event.type === "subagent" && event.subagent.status === "stopped") ended.resolve();
    }, { intervalMs: 0, pollMs: 30 });
    commands.start("b1", { goal: "ticks", stoppable: true });
    commands.follow("b1", file);
    await sleep(60);
    appendFileSync(file, "tick 2\n" + "x".repeat(20_000) + "\ntick 3\n");
    await sleep(90);
    const last = rows(events).at(-1)!;
    assert.equal(last.summary, "tick 3");
    assert.equal(last.outputTruncated, true);
    assert.ok(last.output!.length <= 8192);
    commands.end("b1", "stopped");
    await ended.promise;
    assert.equal(rows(events).at(-1)!.status, "stopped", "its row ends with the file's end read once more");
    const count = events.length;
    appendFileSync(file, "tick 4\n");
    await sleep(90);
    assert.equal(events.length, count, "not read once it ended");

    const link = join(folder, "b2.output");
    symlinkSync(file, link);
    const linked = new BackgroundCommands((event) => events.push(event), { intervalMs: 0, pollMs: 30 });
    linked.start("b2", { goal: "linked", stoppable: false });
    linked.follow("b2", link);
    await sleep(90);
    assert.equal(rows(events).filter((row) => row.id === "b2").at(-1)!.output, undefined);
    linked.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("close says the commands still running are no longer followed", () => {
  const events: ProviderEvent[] = [];
  const commands = new BackgroundCommands((event) => events.push(event));
  commands.start("a", { goal: "a", stoppable: true });
  commands.close();
  assert.equal(rows(events).at(-1)!.status, "stopped");
  assert.equal(rows(events).at(-1)!.result, "Portals stopped following this command.");
});

test("the replay log keeps only a command row's latest progress, past the turn's end, and none once it completed", () => {
  const log = new EventLog("s", 10);
  const row: SubagentInfo = { id: "exec-1", kind: "command", goal: "ticks", status: "running", startedAt: 0, background: true, stoppable: true };
  log.append("subagent.start", subagentPayload(row, 1));
  for (let tick = 0; tick < 50; tick += 1) log.append("subagent.progress", subagentPayload({ ...row, summary: `tick ${tick}`, output: `tick ${tick}\n` }, 1));
  log.append("message.complete", {});
  let replay = log.since(0).events;
  assert.deepEqual(replay.map((event) => event.type), ["subagent.start", "subagent.progress", "message.complete"]);
  assert.equal(replay[1].payload!.summary, "tick 49");
  assert.equal(replay[1].payload!.output, "tick 49\n");
  log.append("subagent.complete", subagentPayload({ ...row, status: "completed" }, 1));
  replay = log.since(0).events;
  assert.deepEqual(replay.map((event) => event.type), ["subagent.start", "message.complete", "subagent.complete"]);
  // An agent's progress is kept in the ring as before.
  log.append("subagent.progress", subagentPayload({ ...row, id: "agent-1", kind: "agent" }, 1));
  assert.equal(log.since(0).events.at(-1)!.type, "subagent.progress");
});

test("rows that left the line keep none of their output in the session: a thread that runs many commands holds only what it shows", async () => {
  const record: ThreadRecord = { id: "commands-cleared", agent: "stand-in", cwd: "/tmp", title: "t", model: "m", provider: "p", reasoningEffort: "low", createdAt: 0, updatedAt: 0, origin: "phone" };
  const core = new Session(record, { has: () => false, get: () => undefined } as unknown as Registry);
  const agent: ProviderSession = {
    history: async () => [], settings: () => ({ model: "m", provider: "p", reasoningEffort: "low" }),
    startTurn: (_prompt: Prompt) => {}, interrupt: async () => false, setModel: async () => ({ deferred: false }), setReasoning: async () => {}, close: async () => {},
  };
  const sink: SessionSink = core.sink;
  await core.attach(agent);
  const output = "x".repeat(8000);
  const nextStep = () => new Promise<void>((resolve) => setImmediate(resolve));
  for (let turn = 0; turn < 20; turn += 1) {
    // Each message takes the rows that had ended off the line (`subagent.cleared`).
    core.submit(`run it ${turn}`).begin?.();
    await nextStep();
    for (let index = 0; index < 4; index += 1) {
      const id = `cmd-${turn}-${index}`;
      sink.emit({ type: "subagent", subagent: { id, kind: "command", goal: "npm run dev", status: "running", startedAt: 1, background: true, stoppable: true, output } });
      sink.emit({ type: "subagent", subagent: { id, kind: "command", goal: "npm run dev", status: "completed", startedAt: 1, endedAt: 2, background: true, stoppable: false, output, result: "done" } });
    }
    sink.emit({ type: "turn.end", status: "complete" });
    await nextStep();
  }
  // The last turn's four are on the line, with their output.
  assert.equal(core.subagentList().length, 4);
  assert.ok(core.subagentList().every((row) => row.output === output));
  // The 76 that left it are kept only to know them again (their run), not with 8 KB each.
  const held = (core as unknown as { subagents: Map<string, { cleared?: boolean; info: SubagentInfo }> }).subagents;
  const left = [...held.values()].filter((entry) => entry.cleared);
  assert.equal(left.length, 76);
  assert.ok(left.every((entry) => entry.info.output === undefined && entry.info.result === undefined), "a row off the line holds no output");
  await core.close();
});
