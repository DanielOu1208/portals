import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { startBridge } from "../../../bridge/src/bridge.ts";
import { parseConfig, pathsFor } from "../../../bridge/src/config.ts";
import { hashPassword } from "../../../bridge/src/http/auth.ts";
import { DroidProvider } from "../../../bridge/src/providers/droid/provider.ts";
import type { DroidSession } from "../../../bridge/src/providers/droid/session.ts";
import type { ProviderEvent } from "../../../bridge/src/providers/types.ts";
import { TestClient, username, password } from "../../../bridge/test/helpers.ts";
import { approvedModel, childProcesses, historyMetadata, SdkObservation } from "./droid-pr2-observe.mts";

// Preparation is inert. The orchestrator must explicitly authorize this invocation.
export async function main(args = process.argv.slice(2)): Promise<void> {
  function argument(name: string): string {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
    return args[index + 1]!;
  }
  if (args.includes("--help")) {
    console.log("droid-pr2-check.mts --fixes-ready --contract-version VERSION --case isolated|lifecycle|interrupt|offerings|progress|tokens|resume|handoff|handoff-followup --out /private/tmp/portals-droid-pr2-* [--quiet-offerings-confirmed]");
    return;
  }
  assert.ok(args.includes("--fixes-ready"), "Do not execute before orchestrator fixes-ready authorization");
  const name = argument("--case");
  const out = resolve(argument("--out"));
  assert.ok(out.startsWith("/private/tmp/portals-droid-pr2-"), "Use a fresh private PR2 artifact root");
  mkdirSync(out, { mode: 0o700 });
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const branch = execFileSync("git", ["-C", repository, "branch", "--show-current"], { encoding: "utf8" }).trim();
  assert.equal(branch, "droid-parity", "Never silently switch branches");
  const sha = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const contractVersion = argument("--contract-version");
  writeFileSync(join(out, "provenance.json"), JSON.stringify({ branch, sha, contractVersion, case: name,
    model: approvedModel, node: process.version, at: Date.now() }), { mode: 0o600, flag: "wx" });

  if (name === "isolated") {
    const files = ["droid-provider", "droid-work", "droid-live", "droid-queue", "droid-rpc", "droid-commands", "eventlog", "queue", "session-resync"];
    const result = spawnSync(process.execPath, ["--test", ...files.map((file) => join(repository, "bridge/test", `${file}.test.ts`))],
      { cwd: join(repository, "bridge"), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
    writeFileSync(join(out, "isolated-tests.log"), result.stdout + result.stderr, { mode: 0o600, flag: "wx" });
    assert.equal(result.status, 0, "Owner tests must pass; retain output even on failure");
    console.log("Isolated owner test files passed; inspect named coverage per review item, not only exit status.");
    return;
  }

  assert.ok(["lifecycle", "interrupt", "offerings", "progress", "tokens", "resume", "handoff", "handoff-followup"].includes(name));
  const handoff = name === "handoff" || name === "handoff-followup";
  if (name === "offerings") assert.ok(args.includes("--quiet-offerings-confirmed"), "Requires the orchestrator's separate quiet CLI-creation window");
  const command = process.env.DROID_RECORD_PATH ?? "";
  assert.ok(isAbsolute(command), "Use the explicitly approved CLI 0.245.0 path");
  const cliVersion = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
  assert.ok(cliVersion.includes("0.245.0"));
  const sdkVersion = (JSON.parse(readFileSync(join(repository, "bridge/node_modules/@factory/droid-sdk/package.json"), "utf8")) as { version: string }).version;
  writeFileSync(join(out, "runtime.json"), JSON.stringify({ command, cliVersion, sdkVersion }), { mode: 0o600, flag: "wx" });
  const home = mkdtempSync(join(out, "bridge-"));
  const projects = ["a", "b", "c"].map((label) => {
    const cwd = join(out, `project-${label}`);
    mkdirSync(join(cwd, ".factory", "commands"), { recursive: true });
    mkdirSync(join(cwd, ".factory", "droids"), { recursive: true });
    execFileSync("/usr/bin/git", ["-C", cwd, "init", "--quiet"]);
    writeFileSync(join(cwd, "hello.txt"), "pear\n", { flag: "wx" });
    writeFileSync(join(cwd, ".factory", "commands", `pr2-${label}.md`),
      `---\ndescription: PR2 project ${label}\n---\nReply exactly pr2-${label}-$ARGUMENTS. No tools.\n`, { flag: "wx" });
    writeFileSync(join(cwd, ".factory", "droids", "parity-ui-helper.md"),
      "---\nname: parity-ui-helper\ndescription: PR2 read-only helper\nmodel: claude-haiku-5-5\ntools: [\"Read\"]\n---\nRead only hello.txt in the task's scratch cwd. Write only the requested report. No other files, tools or network.\n", { flag: "wx" });
    return cwd;
  });
  const config = {
    host: "127.0.0.1", port: 0, auth: { username, passwordHash: await hashPassword(password) },
    generalFolder: projects[0], apns: null, push: { relay: null, dryRun: join(out, "push.jsonl") },
    // No standby link to the deployed relay: the relay is on unless set off.
    relay: { enabled: false },
    fleet: { tellAgents: false }, visuals: { tellAgents: false }, aeri: { enabled: false },
    providers: { claude: false, codex: false, pi: false, cursor: false, droid: true, hermes: false, fake: false },
    droid: { path: command, idleMinutes: 1, maxWarm: 1 },
  };
  parseConfig(config);
  writeFileSync(join(home, "config.json"), JSON.stringify(config), { mode: 0o600, flag: "wx" });
  const observation = new SdkObservation(command, join(out, "metrics.jsonl"));
  const provider = new DroidProvider({ command, directory: pathsFor(home).droid, idleMs: 1000, maxWarm: 1,
    interruptGraceMs: 3000, checkVersion: false, sdk: observation.sdk });
  const sessions = new Map<string, DroidSession>();
  const emitted: { thread: string; event: ProviderEvent }[] = [];
  const startSession = provider.startSession.bind(provider);
  provider.startSession = async (options, sink) => {
    const session = await startSession(options, { ...sink, emit(event) {
      emitted.push({ thread: options.id, event });
      const fields: Record<string, unknown> = { thread: options.id };
      if (event.type === "tool.progress") Object.assign(fields, { id: event.id, bytes: Buffer.byteLength(event.output ?? ""),
        lines: (event.output ?? "").split("\n").length, truncated: event.outputTruncated });
      if (event.type === "tool.start" || event.type === "tool.end") Object.assign(fields, { id: event.id, name: event.name });
      if (event.type === "turn.usage") fields.tokens = event.usage.tokens;
      if (event.type === "turn.end") fields.status = event.status;
      if (event.type === "subagent") Object.assign(fields, { id: event.subagent.id, status: event.subagent.status, background: event.subagent.background });
      observation.record(`provider.${event.type}`, fields);
      sink.emit(event);
    } });
    sessions.set(options.id, session);
    return session;
  };
  const bridge = await startBridge({ home, providers: new Map([["droid", provider]]), temporaryFolders: [] });
  let client = await TestClient.open(bridge).catch(async (error: unknown) => { await bridge.close(); throw error; });
  let nextRequest = 0;
  let requestCursor = 0;
  const backgroundCommand = "sleep 20; printf 'parity-background-complete\\n'";
  const progressCommand = "python3 -c \"import time; [(print('pr2-%04d '%i+'x'*240, flush=True),time.sleep(.02)) for i in range(160)]; print('pr2-output-done', flush=True)\"";

  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = `pr2-${++nextRequest}`;
    client.send({ jsonrpc: "2.0", id, method, params });
    const response = await client.find((frame) => frame.id === id && frame.method === undefined, 120_000);
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  }

  function answerApprovals(): void {
    for (; requestCursor < client.frames.length; requestCursor += 1) {
      const frame = client.frames[requestCursor];
      if (frame.method !== "approval" && frame.method !== "clarify") continue;
      if (frame.method === "approval" && handoff && typeof frame.params.plan_content === "string") {
        assert.ok(frame.params.plan_content.includes("sleep 20") && frame.params.plan_content.includes("parity-background-complete"), "Approve only the bounded approved plan");
        assert.ok(frame.params.options?.some((option: { id: string }) => option.id === "proceed_new_session_low"), "Do not invent an unoffered Spec outcome");
        observation.record("approval.option", { option: "proceed_new_session_low" });
        client.answer(frame.id, { option: "proceed_new_session_low" });
      } else if (frame.method === "approval" && [backgroundCommand, progressCommand].some((wanted) => frame.params.command === wanted)) {
        observation.record("approval.once");
        client.answer(frame.id, { choice: "once" });
      } else {
        client.answer(frame.id, frame.method === "approval" ? { choice: "deny" } : { answers: null });
        throw new Error("Unexpected approval/question; declined rather than broadening permissions");
      }
    }
  }

  async function until(check: () => boolean, description: string, timeout = 120_000): Promise<void> {
    const end = Date.now() + timeout;
    while (!check()) {
      answerApprovals();
      if (Date.now() > end) throw new Error(`Timed out: ${description}`);
      await sleep(50);
    }
  }

  async function create(index = 0): Promise<string> {
    return (await rpc("session.create", { profile: "droid", source: "tui", cwd: projects[index],
      model: approvedModel, provider: "droid", reasoning_effort: "medium" })).session_id;
  }

  async function turn(thread: string, text: string): Promise<void> {
    const mark = emitted.length;
    await rpc("prompt.submit", { session_id: thread, text });
    await until(() => emitted.slice(mark).some((row) => row.thread === thread && row.event.type === "turn.end"), "turn end");
    const end = emitted.slice(mark).findLast((row) => row.thread === thread && row.event.type === "turn.end")!.event;
    assert.ok(end.type === "turn.end" && end.status === "complete", "Native turn must complete, not merely stop");
  }

  async function cooled(thread: string): Promise<void> {
    await until(() => !sessions.get(thread)!.busy && provider.pool.size === 0 && observation.closes === observation.opens, "idle eviction and completed native close", 15_000);
  }

  function tools(thread: string, id?: string): Extract<ProviderEvent, { type: "tool.end" }>[] {
    return emitted.filter((row) => row.thread === thread).map((row) => row.event)
      .filter((event): event is Extract<ProviderEvent, { type: "tool.end" }> => event.type === "tool.end" && (!id || event.id === id));
  }

  function backgroundStart(thread: string): Extract<ProviderEvent, { type: "tool.start" }> {
    const start = emitted.find((row) => row.thread === thread && row.event.type === "tool.start" && row.event.name === "terminal");
    assert.ok(start?.event.type === "tool.start");
    assert.equal(start.event.args.command, backgroundCommand, "Only the exact bounded command is authorized");
    assert.equal(start.event.args.fireAndForget, true);
    return start.event;
  }

  function finalBackground(thread: string, id: string): boolean {
    return tools(thread, id).some((event) => {
      const result = event.result as { output?: string };
      return /(?:^|\n)parity-background-complete(?:\n|$)/.test(result.output ?? "");
    });
  }

  async function resumedTool(thread: string, id: string): Promise<{ content: string }> {
    await client.close();
    client = await TestClient.open(bridge);
    requestCursor = 0;
    const snapshot = await rpc("session.resume", { session_id: thread });
    const rows = snapshot.messages.filter((row: any) => row.role === "tool" && row.tool_call_id === id);
    assert.equal(rows.length, 1, "Full resume must contain one original tool row");
    observation.record("resume.single-tool-row", { thread, id });
    return rows[0];
  }

  async function completedBackground(thread: string): Promise<string> {
    const id = backgroundStart(thread).id;
    await until(() => finalBackground(thread, id), "background final output", 90_000);
    assert.ok(!tools(thread, id).some((event) => /tracking ended/i.test(JSON.stringify(event.result))));
    const row = await resumedTool(thread, id);
    assert.equal((row.content.match(/parity-background-complete/g) ?? []).length, 1);
    return id;
  }

  try {
    await provider.models(); // Startup discovery is outside the #5 no-spawn window.
    for (const cwd of projects.slice(1)) await rpc("folders.add", { path: cwd });
    if (name === "offerings") {
      const threads: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const thread = await create(index);
        await turn(thread, "Reply exactly ready. Do not use tools.");
        await rpc("commands.catalog", { session_id: thread });
        await cooled(thread);
        threads.push(thread);
      }
      const before = { history: historyMetadata(), processes: await childProcesses(), opens: observation.opens, models: observation.modelLists };
      writeFileSync(join(out, "offerings-before.json"), JSON.stringify(before), { mode: 0o600, flag: "wx" });
      assert.equal(before.processes.length, 0, "Start with all owned native processes closed");
      for (let repeat = 0; repeat < 2; repeat += 1) {
        for (const [index, thread] of threads.entries()) {
          await rpc("session.resume", { session_id: thread });
          await rpc("model.options", { profile: "droid" });
          const catalog = await rpc("commands.catalog", { session_id: thread });
          assert.ok(catalog.pairs.some((entry: [string, string]) => entry[0] === `/pr2-${["a", "b", "c"][index]}`));
        }
        const personal = await rpc("commands.catalog", { profile: "droid" });
        assert.ok(!personal.pairs.some((entry: [string, string]) => /^\/pr2-[abc]$/.test(entry[0])), "No-thread offerings must not infer a project");
        await client.close();
        client = await TestClient.open(bridge);
        requestCursor = 0;
      }
      const after = { history: historyMetadata(), processes: await childProcesses(), opens: observation.opens, models: observation.modelLists };
      writeFileSync(join(out, "offerings-metadata.json"), JSON.stringify({ before, after }, null, 2), { mode: 0o600, flag: "wx" });
      assert.equal(after.opens, before.opens);
      assert.equal(after.models, before.models);
      assert.equal(after.processes.length, 0);
      assert.deepEqual(after.history.map((entry) => entry.nameHash), before.history.map((entry) => entry.nameHash), "New CLI history during quiet window: investigate before calling product failure");
    } else if (name === "lifecycle") {
      const thread = await create();
      await turn(thread, "Remember pear. Reply exactly ready. Do not use tools.");
      await cooled(thread);
      assert.ok(observation.rows.some((row) => row.event === "sdk.state" && row.state === "idle"));
      assert.equal((await childProcesses()).length, 0);
      const mark = observation.opens;
      await turn(thread, "Reply only with the remembered fruit. Do not use tools.");
      assert.equal(observation.opens, mark + 1);
      assert.ok(observation.rows.some((row) => row.event === "sdk.open" && row.resume === true));
      await cooled(thread);
    } else if (name === "interrupt") {
      const thread = await create();
      await rpc("prompt.submit", { session_id: thread, text: `Use Task exactly once with subagent_type parity-ui-helper and await true. Read only ${projects[0]}/hello.txt and write a 1200-word report about that fruit. No other tools or files. After the report say done.` });
      await until(() => emitted.some((row) => row.thread === thread && row.event.type === "subagent" && row.event.subagent.status === "running"), "actual awaited child");
      await rpc("session.interrupt", { session_id: thread });
      await until(() => emitted.some((row) => row.thread === thread && row.event.type === "turn.end" && row.event.status === "interrupted"), "interrupted turn");
      await cooled(thread);
      const child = emitted.filter((row) => row.thread === thread && row.event.type === "subagent").at(-1)!.event;
      assert.ok(child.type === "subagent" && child.subagent.status !== "running");
      assert.equal(sessions.get(thread)!.hasBackgroundWork(), false);
    } else if (name === "progress") {
      const thread = await create();
      await Promise.all([
        turn(thread, `Use Execute exactly once, command ${progressCommand}, riskLevel low, summary Bounded PR2 stdout, fireAndForget false. No other tools, commands or file changes. Reply only done.`),
        (async () => {
          await until(() => observation.rows.filter((row) => row.event === "provider.tool.progress").length >= 2, "native in-flight progress");
          const replay = await rpc("session.events.since", { session_id: thread, last_seen: 0 });
          const progress = replay.events.filter((event: { type: string }) => event.type === "tool.progress");
          assert.equal(progress.length, 1, "Replay retains only the latest in-flight progress");
          observation.record("replay.inflight", { count: progress.length, bytes: Buffer.byteLength(JSON.stringify(replay)) });
        })(),
      ]);
      const progress = observation.rows.filter((row) => row.event === "provider.tool.progress");
      assert.ok(progress.length >= 2, "Need native progress, not only final output");
      // Native CLI 0.245 can already tail fullOutput at 8192 bytes. Only owner tests
      // prove bridge-side clipping; a bounded native input need not set truncated.
      observation.record("progress.native-limits", {
        maxInputBytes: Math.max(...observation.rows.filter((row) => row.event === "sdk.progress").map((row) => Number(row.bytes) || 0)),
        maxOutputBytes: Math.max(...progress.map((row) => Number(row.bytes))),
        bridgeClipped: progress.some((row) => row.truncated === true),
      });
      for (const row of progress) { assert.ok(Number(row.bytes) <= 8192); assert.ok(Number(row.lines) <= 200); }
      for (let index = 1; index < progress.length - 1; index += 1) assert.ok(progress[index]!.at - progress[index - 1]!.at >= 225, "Progress should coalesce at 250ms, except terminal flush");
      const replay = await rpc("session.events.since", { session_id: thread, last_seen: 0 });
      assert.ok(!replay.events.some((event: { type: string }) => event.type === "tool.progress"));
      writeFileSync(join(out, "progress-replay-metrics.json"), JSON.stringify({ bytes: Buffer.byteLength(JSON.stringify(replay)),
        retainedProgress: JSON.stringify(replay).includes('"type":"tool.progress"'), samples: progress.length }), { mode: 0o600, flag: "wx" });
      const final = tools(thread).find((event) => JSON.stringify(event.result).includes("pr2-output-done"));
      assert.ok(final && Buffer.byteLength(JSON.stringify(final.result)) > 8192, "Final result must not inherit the live-tail cap");
      observation.record("progress.final", { bytes: Buffer.byteLength(JSON.stringify(final.result)), retainedProgress: 0 });
    } else if (name === "tokens") {
      const thread = await create();
      await turn(thread, `Use Task exactly once with subagent_type parity-ui-helper and await true. Read only ${projects[0]}/hello.txt and write a 600-word report about that fruit. No other tools, files or network. After the report say only done.`);
      assert.ok(emitted.some((row) => row.event.type === "subagent" && row.event.subagent.status === "completed"));
      const previous = observation.rows.findLast((row) => row.event === "sdk.tokens");
      assert.ok(typeof previous?.total === "number", "Require native parent-stream baseline");
      const mark = observation.rows.length;
      await turn(thread, "Write 200 numbered lines, each containing only its number and pear. Do not use tools.");
      const updates = observation.rows.slice(mark).filter((row) => row.event === "provider.turn.usage");
      assert.ok(updates.some((row) => Number(row.tokens) > 0), "Subagent aggregate baseline must not zero the next live turn");
      for (const update of updates) {
        const index = observation.rows.indexOf(update);
        const native = observation.rows.slice(0, index).findLast((row) => row.event === "sdk.tokens");
        assert.ok(typeof native?.total === "number");
        assert.equal(update.tokens, Math.max(0, native.total - previous.total));
      }
    } else {
      const thread = await create();
      if (handoff) await rpc("session.set_mode", { session_id: thread, mode: "plan" });
      const task = `Use Execute exactly once with command ${backgroundCommand}, riskLevel low, summary Scratch background timer, fireAndForget true. After launch reply only launched. Never poll, use TaskOutput/TaskStop, run other commands or change files.`;
      await turn(thread, handoff ? `Use ExitSpecMode now to propose a minimal plan containing this exact harmless implementation: ${task} Do not execute before approval. No questions or file changes.` : task);
      if (handoff) {
        const id = backgroundStart(thread).id;
        const source = observation.rows.find((row) => row.event === "sdk.stream")!.session;
        const target = observation.rows.findLast((row) => row.event === "sdk.root" && row.session !== source)?.session;
        assert.ok(typeof target === "string", "Require a real target root session, not a child or guessed ID");
        assert.ok(emitted.some((row) => row.thread === thread && row.event.type === "notice" && row.event.level === "info"
          && row.event.text === "Background work continues in the new session. Portals can't see when it finishes until you send another message."));
        assert.ok(sessions.get(thread)!.hasBackgroundWork() && !finalBackground(thread, id));
        if (name === "handoff-followup") {
          const mark = observation.rows.length;
          await turn(thread, "Reply exactly pr2-handoff-followup. Do not use tools.");
          assert.ok(observation.rows.slice(mark).some((row) => row.event === "sdk.open" && row.resume === true && row.session === target), "Follow-up must resume the target");
          assert.ok(emitted.some((row) => row.thread === thread && row.event.type === "notice" && row.event.level === "info"
            && /stopped tracking/.test(row.event.text)));
          const row = await resumedTool(thread, id);
          assert.match(row.content, /Live tracking ended for background work from the plan; it may already have finished\./);
          assert.ok(!finalBackground(thread, id), "Stopped tracking is not terminal success");
          observation.record("handoff.followup-tracking-ended", { source, target, id });
        } else {
          // Explicitly authorized exception: only this scratch cwd's proven target
          // session, only the matching completion record, never other history bodies.
          assert.match(target, /^[0-9a-f-]{36}$/);
          const history = join(homedir(), ".factory/sessions", projects[0]!.replaceAll("/", "-"), `${target}.jsonl`);
          let matchingRecords = 0;
          await until(() => {
            let body: string;
            try {
              const metadata = lstatSync(history);
              assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 8 * 1024 * 1024);
              body = readFileSync(history, "utf8");
            }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
            matchingRecords = body.split("\n").filter((line) => line.includes(`execute-completion:${id}`)
              && line.includes("parity-background-complete")).length;
            return matchingRecords > 0;
          }, "scratch target native completion record", 60_000);
          await sleep(2000);
          assert.ok(sessions.get(thread)!.hasBackgroundWork(), "Retain the original source while work is unobservable");
          assert.equal(observation.closes, 0, "Do not close the original source without a follow-up");
          assert.ok((await childProcesses()).length > 0);
          assert.ok(!finalBackground(thread, id), "Native completion is not forwarded to the original connection");
          assert.equal(tools(thread, id).length, 1, "No fabricated terminal result beyond the launch receipt");
          const row = await resumedTool(thread, id);
          assert.doesNotMatch(row.content, /tracking ended/i);
          observation.record("handoff.native-limitation", { source, target, id, matchingRecords, sourceHeld: true, completionVisible: false });
        }
      } else await completedBackground(thread);
      if (handoff) assert.ok(observation.rows.some((row) => row.event === "approval.option" && row.option === "proceed_new_session_low"));
    }
  } finally {
    try { await client.close(); }
    finally { await bridge.close(); }
  }
  observation.record("case.pass", { case: name, sha });
  console.log(`PASS ${name}; evidence ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
