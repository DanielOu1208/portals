import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, onTestCleanup } from "./opencode-test.ts";
import { fixtureLocator, processReadFault, stopLocatorFixture } from "./opencode-process.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { type OwnedStopResult } from "../src/providers/opencode/server.ts";
import { FakeOpenCode } from "./opencode-serve.ts";

function rig(scenario: object, onStop?: (result: OwnedStopResult) => void | Promise<void>) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "portals-owned-stop-")));
  const program = join(folder, "opencode"), state = join(folder, "state.json"), proof = join(folder, "proof");
  writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("./opencode-shutdown-standin.ts", import.meta.url))}" "$@"\n`);
  chmodSync(program, 0o755);
  writeFileSync(proof, "");
  const results: OwnedStopResult[] = [];
  onTestCleanup(() => rmSync(folder, { recursive: true, force: true }));
  const locator = fixtureLocator({ path: program, mode: "own", start: false, cwd: folder,
    logPath: join(folder, "serve.log"), settleTimeoutMs: "hang" in scenario || "noIdle" in scenario ? 300 : undefined,
    env: { ...process.env, OPENCODE_SHUTDOWN_SCENARIO: JSON.stringify(scenario), OPENCODE_SHUTDOWN_STATE: state, OPENCODE_SHUTDOWN_PROOF: proof },
    onStop(result) { results.push(result); return onStop?.(result); },
  });
  return { locator, folder, proof, results, state: () => JSON.parse(readFileSync(state, "utf8")),
    async close() { try { await locator.close(); } finally { await stopLocatorFixture(locator); rmSync(folder, { recursive: true, force: true }); } } };
}

test("owned stop interrupts roots and children and records terminal idle before TERM", async () => {
  const r = rig({ active: ["ses_root", "ses_child"], delay: 40, assistant: true });
  try {
    assert.equal(r.locator.stopDeadlineMs, undefined);
    const endpoint = await r.locator.locate();
    assert.equal(r.locator.stopDeadlineMs, 16_000);
    const closing = r.locator.close();
    assert.equal(r.locator.close(), closing);
    await closing;
    assert.deepEqual(r.results, [{ serverIdentity: endpoint.serverIdentity, settled: ["ses_root", "ses_child"], unsettled: [], complete: true,
      executions: ["ses_root", "ses_child"].map((sessionID) => ({ sessionID, openerID: "old_user", assistantID: "assistant_" + sessionID, terminalID: "idle_" + sessionID, outcome: "interrupted" })),
    }]);
    for (const id of ["ses_root", "ses_child"]) {
      const calls = r.state().calls;
      assert.ok(calls.findIndex((call: any) => call.path === `/api/session/${id}/message`) <
        calls.findIndex((call: any) => call.path === `/api/session/${id}/interrupt`), "identity is read before interrupt");
    }
    assert.deepEqual(r.state().active, []);
    assert.deepEqual(r.state().idle, { ses_root: "interrupted", ses_child: "interrupted" });
    assert.equal(r.state().term, true);
    assert.equal(r.state().calls.filter((call: any) => call.path.endsWith("/interrupt")).length, 2);
    assert.ok(r.state().calls.filter((call: any) => call.path.endsWith("/interrupt")).every((call: any) => call.query.resume === "false"));
    assert.equal(r.locator.stopDeadlineMs, undefined);
  } finally { await r.close(); }
});

test("owned stop catches a newly active child while confirming the parent", async () => {
  const r = rig({ active: ["ses_root"], lateChild: "ses_late" });
  try {
    await r.locator.locate();
    await r.locator.close();
    assert.deepEqual(r.results[0].settled, ["ses_root", "ses_late"]);
    assert.equal(r.results[0].complete, true);
  } finally { await r.close(); }
});

test("failed startup settles a subsequently verified responsive owned server before stopping it", async () => {
  const r = rig({ active: ["ses_root"], firstWrong: true });
  try {
    await assert.rejects(r.locator.locate(), /did not prove its PID/);
    assert.deepEqual(r.results[0].settled, ["ses_root"]);
    assert.equal(r.results[0].complete, true);
    assert.equal(r.state().term, true);
    await r.locator.close();
    assert.equal(r.results.length, 1);
  } finally { await r.close(); }
});

for (const outcome of ["succeeded", "failed"] as const) {
  test(`a native ${outcome} outcome racing with interruption is preserved in the stop callback`, async () => {
    const r = rig({ active: ["ses_root"], finish: outcome });
    try {
      await r.locator.locate();
      await r.locator.close();
      assert.deepEqual(r.results[0].settled, ["ses_root"]);
      assert.equal(r.results[0].complete, true);
      assert.deepEqual(r.results[0].executions, [{ sessionID: "ses_root", openerID: "old_user", terminalID: "idle_ses_root", outcome }]);
    } finally { await r.close(); }
  });
}

test("a child exiting during native settlement is never signalled again after exit cleanup", async (t) => {
  const r = rig({ active: ["ses_root"], hang: "active" });
  const kill = process.kill.bind(process);
  const signals: { pid: number; signal: NodeJS.Signals | number | undefined }[] = [];
  t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    signals.push({ pid, signal });
    return kill(pid, signal);
  });
  try {
    const endpoint = await r.locator.locate();
    const child = (r.locator as unknown as { child: ChildProcess }).child;
    const gone = once(child, "exit");
    const closing = r.locator.close();
    const deadline = Date.now() + 20_000;
    while (!r.state().calls.some((call: { path: string }) => call.path === "/api/session/active")) {
      assert.ok(Date.now() < deadline, "shutdown reached native settlement");
      await sleep(5);
    }
    kill(endpoint.pid!, "SIGKILL");
    await gone;
    await closing;
    assert.equal(child.signalCode, "SIGKILL");
    assert.deepEqual(signals.filter(({ pid, signal }) => pid === -endpoint.pid! && signal === "SIGTERM"),
      [{ pid: -endpoint.pid!, signal: "SIGTERM" }], "only the immediate exit listener cleans up the old group");
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].complete, false);
    assert.equal(existsSync(join(r.folder, "serve.log.server.json")), false);
  } finally { await r.close(); }
});

test("partially settled sessions remain distinguishable from an unsuccessful interrupt", async () => {
  const r = rig({ active: ["ses_root", "ses_child"], fail: "ses_child" });
  try {
    await r.locator.locate();
    await r.locator.close();
    assert.deepEqual(r.results[0].settled, ["ses_root"]);
    assert.deepEqual(r.results[0].unsettled, ["ses_child"]);
    assert.equal(r.results[0].complete, false);
  } finally { await r.close(); }
});

for (const scenario of [{ noIdle: ["ses_root"] }, { noIdle: ["ses_root"], staleIdle: true }, { fail: "ses_root" }, { hang: "interrupt" }, { hang: "message" }]) {
  test(`owned stop remains bounded and reports an unconfirmed native terminal state: ${JSON.stringify(scenario)}`, async () => {
    const r = rig({ active: ["ses_root"], ...scenario });
    try {
      await r.locator.locate();
      await r.locator.close();
      assert.equal(r.results.length, 1);
      assert.deepEqual(r.results[0].unsettled, ["ses_root"]);
      assert.equal(r.results[0].complete, false);
      assert.equal(r.state().term, true);
      if (scenario.hang === "message") assert.ok(r.state().calls.some((call: any) => call.path.endsWith("/interrupt")), "a hung identity read cannot prevent interrupt");
    } finally { await r.close(); }
  });
}

test("an empty owned inventory still notifies before TERM", async () => {
  let beforeTerm = false;
  const r = rig({}, () => { beforeTerm = r.state().term === false; });
  try {
    await r.locator.locate();
    await r.locator.close();
    assert.equal(beforeTerm, true);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].complete, true);
    assert.deepEqual(r.results[0].settled, []);
  } finally { await r.close(); }
});

test("unresponsive inventory is unknown, not a falsely successful empty result", async () => {
  const r = rig({ active: ["ses_root"], hang: "active" });
  try {
    await r.locator.locate();
    await r.locator.close();
    assert.deepEqual(r.results[0], { serverIdentity: r.results[0].serverIdentity, settled: [], unsettled: [], complete: false });
    assert.equal(r.state().term, true);
  } finally { await r.close(); }
});

test("wrong native PID proof cannot authorize session interruption", async () => {
  const r = rig({ active: ["ses_root"] });
  try {
    await r.locator.locate();
    writeFileSync(r.proof, "wrong");
    await r.locator.close();
    assert.equal(r.results[0].complete, false);
    assert.ok(r.state().calls.every((call: any) => !call.path.endsWith("/interrupt")));
  } finally { await r.close(); }
});

for (const callback of [() => { throw new Error("notification failed"); }, () => new Promise<void>(() => {})]) {
  test("a throwing or never-settling stop notification cannot prevent termination", async () => {
    const r = rig({ active: ["ses_root"] }, callback);
    try {
      await r.locator.locate();
      await r.locator.close();
      assert.equal(r.state().term, true);
      assert.equal(existsSync(join(r.folder, "serve.log.server.json")), false);
    } finally { await r.close(); }
  });
}

test("shared close has no stop budget, native interrupt, or stop notification", async () => {
  const fake = await FakeOpenCode.start();
  const r = rig({});
  const file = join(r.folder, "service.json");
  writeFileSync(file, JSON.stringify({ pid: process.pid, version: fake.version, url: fake.url, password: fake.password }));
  let called = false;
  const locator = fixtureLocator({ path: join(r.folder, "opencode"), mode: "shared", start: false, cwd: r.folder,
    logPath: join(r.folder, "shared.log"), registration: file, onStop() { called = true; } });
  try {
    assert.equal((await locator.locate()).own, false);
    assert.equal(locator.stopDeadlineMs, undefined);
    await locator.close();
    assert.equal(called, false);
    assert.equal(fake.callsOf("POST", /interrupt$/).length, 0);
    assert.equal(fake.callsOf("GET", /active$/).length, 0);
  } finally { await locator.close(); await fake.close(); await r.close(); }
});


test("one unreadable owned-child identity is retried before signalling", { skip: process.platform !== "darwin" }, async (t) => {
  const r = rig({});
  try {
    const endpoint = await r.locator.locate();
    const reads = processReadFault(t, endpoint.pid!, (read) => read === 2 ? "unreadable" : undefined);
    await r.locator.close();
    assert.ok(reads() >= 3, "a new matching OS proof must be read after the transient miss");
    assert.equal(r.results[0].complete, true);
    assert.equal(r.state().term, true);
    assert.equal(existsSync(join(r.folder, "serve.log.server.json")), false);
  } finally { await r.close(); }
});

for (const fault of ["unreadable", "different"] as const) {
  test(`persistent ${fault} owned-child identity never authorizes a signal`, { skip: process.platform !== "darwin" }, async (t) => {
    const r = rig({});
    const endpoint = await r.locator.locate();
    const reads = processReadFault(t, endpoint.pid!, () => fault);
    await assert.rejects(r.locator.close(), /Cannot safely reclaim OpenCode/);
    assert.equal(r.state().term, false);
    assert.doesNotThrow(() => process.kill(endpoint.pid!, 0), "unknown identity must leave the process alone");
    assert.equal(existsSync(join(r.folder, "serve.log.server.json")), true);
    assert.equal(r.results.length, 1);
    if (fault === "different") assert.equal(reads(), 2, "a positive mismatch is never retried into authorization");
    // The test wrapper independently kills this fixture after the expected refusal.
  });
}
