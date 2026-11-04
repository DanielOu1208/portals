import "./environment.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { backgroundProcesses, DroidBackground, type BackgroundProcess } from "../src/providers/droid/background.ts";
import type { ProviderEvent, SubagentInfo } from "../src/providers/types.ts";

/** Waits until `check` holds. */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("timed out");
    await sleep(5);
  }
}

function rows(events: ProviderEvent[], id?: string): SubagentInfo[] {
  return events.flatMap((event) => (event.type === "subagent" && (!id || event.subagent.id === id) ? [event.subagent] : []));
}

function rig(options: { atWork?: () => boolean; waitMs?: number; holdMs?: number } = {}) {
  const events: ProviderEvent[] = [];
  const background = new DroidBackground((event) => events.push(event), { intervalMs: 0, pollMs: 20, ...options });
  return { events, background, last: (id: string) => rows(events, id).at(-1) };
}

/** A process as Droid 1.3.0 lists it (`background_processes_changed`). */
function listed(id: string, pid: number, command = "npm run dev", outputFile?: string): BackgroundProcess {
  return { id, pid, command, startedAtMs: 1_793_000_000_000 + pid, ...(outputFile ? { outputFile } : {}) };
}

test("Droid's list of background processes is read as it sends it, and what cannot be read is left out", () => {
  assert.deepEqual(backgroundProcesses([
    { id: "toolu_1", pid: 73152, command: "sleep 12; echo done", startedAtMs: 1793763090554, toolUseId: "toolu_1",
      outputFile: "/tmp/droid-bg-1793763090554-53c657cb-a9e9-4388-bdf0-df29e17c6298.out" },
    { id: "", pid: 1, command: "no id" }, { id: "x", pid: "2", command: "pid as text" }, { id: "y", pid: 3 }, null,
  ]), [{ id: "toolu_1", pid: 73152, command: "sleep 12; echo done", startedAtMs: 1793763090554,
    outputFile: "/tmp/droid-bg-1793763090554-53c657cb-a9e9-4388-bdf0-df29e17c6298.out" }]);
  assert.deepEqual(backgroundProcesses([]), []);
  assert.equal(backgroundProcesses(undefined), undefined);
});

test("a background command Droid lists is a command row with a Stop, its output read from Droid's file, and ends as Droid tells", { timeout: 10_000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "droid-bg-"));
  try {
    const process = listed("toolu_1", 4242, "for i in 1 2 3; do echo tick $i; sleep 1; done");
    const file = join(folder, `droid-bg-${process.startedAtMs}-53c657cb-a9e9-4388-bdf0-df29e17c6298.out`);
    writeFileSync(file, "tick 1\n");
    const r = rig();
    r.background.list([{ ...process, outputFile: file }]);
    assert.deepEqual(r.last("toolu_1#4242"), {
      id: "toolu_1#4242", kind: "command", goal: "for i in 1 2 3; do echo tick $i; sleep 1; done", status: "running",
      startedAt: process.startedAtMs, background: true, stoppable: true,
    });
    assert.equal(r.background.target("toolu_1#4242"), "toolu_1", "stopped by Droid's id for it");
    await until(() => r.last("toolu_1#4242")!.summary === "tick 1");
    appendFileSync(file, "tick 2\n");
    await until(() => r.last("toolu_1#4242")!.summary === "tick 2");
    // The same list again (another command's start or end) changes nothing.
    const count = r.events.length;
    r.background.list([{ ...process, outputFile: file }]);
    assert.equal(r.events.length, count);
    // Droid tells how it ended just before its list no longer has it (CLI 1.3).
    appendFileSync(file, "tick 3\n");
    r.background.finished("toolu_1", "failed");
    assert.equal(r.last("toolu_1#4242")!.status, "running");
    r.background.list([]);
    // Its row says so once the file's end has been read.
    await until(() => r.last("toolu_1#4242")!.status !== "running");
    const last = r.last("toolu_1#4242")!;
    assert.equal(last.status, "failed");
    assert.equal(last.stoppable, false);
    assert.equal(last.output, "tick 1\ntick 2\ntick 3\n", "with its file's end");
    assert.equal(r.background.target("toolu_1#4242"), undefined);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("only a file named as Droid names a command's output is read", { timeout: 10_000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "droid-bg-"));
  try {
    const r = rig();
    const process = listed("toolu_1", 1);
    const named = (name: string) => { const path = join(folder, name); writeFileSync(path, "secret\n"); return path; };
    r.background.list([
      { ...process, outputFile: named("notes.txt") },
      { ...listed("toolu_2", 2), outputFile: named(`droid-bg-${process.startedAtMs}-53c657cb-a9e9-4388-bdf0-df29e17c6298.out`) },
      { ...listed("toolu_3", 3), outputFile: `droid-bg-${listed("toolu_3", 3).startedAtMs}-53c657cb-a9e9-4388-bdf0-df29e17c6298.out` },
    ]);
    await sleep(60);
    for (const id of ["toolu_1#1", "toolu_2#2", "toolu_3#3"]) assert.equal(r.last(id)!.output, undefined, id);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a Droid command that left the list before Droid said how it ended waits for that, the longer while Droid is at work", async () => {
  let atWork = true;
  const r = rig({ atWork: () => atWork, waitMs: 20, holdMs: 10_000 });
  r.background.list([listed("toolu_1", 1)]);
  r.background.list([]);
  assert.equal(r.last("toolu_1#1")!.status, "running");
  assert.equal(r.last("toolu_1#1")!.stoppable, false, "its process is gone: nothing to stop");
  // Droid tells it only after the tool it runs meanwhile.
  await sleep(80);
  assert.equal(r.last("toolu_1#1")!.status, "running");
  r.background.finished("toolu_1", "failed");
  assert.equal(r.last("toolu_1#1")!.status, "failed");

  // Idle, and no word: it ended, how is not known.
  r.background.list([listed("toolu_2", 2)]);
  r.background.list([]);
  atWork = false;
  await until(() => r.last("toolu_2#2")!.status !== "running");
  assert.equal(r.last("toolu_2#2")!.status, "completed");
});

test("two Droid commands under one id are two rows, neither stopped by Droid's id while both run, each ended as it leaves the list", () => {
  const r = rig();
  r.background.list([listed("call_0", 10)]);
  assert.equal(r.last("call_0#10")!.stoppable, true);
  // A model that numbers its calls afresh in each answer: another command under call_0.
  r.background.list([listed("call_0", 10), listed("call_0", 11, "npm test")]);
  assert.equal(r.last("call_0#10")!.stoppable, false, "Droid would stop whichever it finds first");
  assert.equal(r.last("call_0#11")!.stoppable, false);
  assert.equal(r.background.target("call_0#10"), undefined);
  assert.equal(r.background.target("call_0#11"), undefined);
  // The newer one ends: Droid's word goes to the one that left its list, not the older.
  r.background.finished("call_0", "completed");
  r.background.list([listed("call_0", 10)]);
  assert.equal(r.last("call_0#11")!.status, "completed");
  assert.equal(r.last("call_0#10")!.status, "running");
  assert.equal(r.last("call_0#10")!.stoppable, true, "alone again under its id, it can be stopped");
  assert.equal(r.background.target("call_0#10"), "call_0");
});

test("two Droid commands under one id that left the list before Droid's word take its words in the order they left", () => {
  const r = rig({ atWork: () => true, waitMs: 60_000, holdMs: 60_000 });
  r.background.list([listed("call_0", 10), listed("call_0", 11, "npm test")]);
  // The newer leaves first, the older next, both while a foreground tool runs: Droid's
  // words on them come after that tool, in the order they ended.
  r.background.list([listed("call_0", 10)]);
  r.background.list([]);
  assert.equal(r.last("call_0#10")!.status, "running");
  assert.equal(r.last("call_0#11")!.status, "running");
  r.background.finished("call_0", "failed");
  assert.equal(r.last("call_0#11")!.status, "failed", "the first word is the one that left first");
  assert.equal(r.last("call_0#10")!.status, "running");
  r.background.finished("call_0", "completed");
  assert.equal(r.last("call_0#10")!.status, "completed");
  r.background.close();
});

test("a Droid command stopped from Portals ends as stopped; close lets go of those still running", () => {
  const r = rig();
  r.background.list([listed("toolu_1", 1), listed("toolu_2", 2)]);
  r.background.stopping("toolu_1#1");
  assert.equal(r.last("toolu_1#1")!.stoppable, false);
  r.background.finished("toolu_1", "failed");
  r.background.list([listed("toolu_2", 2)]);
  assert.equal(r.last("toolu_1#1")!.status, "stopped", "SIGTERM's exit status is the Stop's");
  r.background.close();
  assert.equal(r.last("toolu_2#2")!.status, "stopped");
  assert.equal(r.last("toolu_2#2")!.result, "Portals stopped following this command.");
});
