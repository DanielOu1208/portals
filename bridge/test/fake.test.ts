import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DroidParityFakeProvider, FakeProvider } from "../src/providers/fake.ts";
import { benchSteps, playBench, type BenchPlayer } from "../src/providers/fakeBench.ts";
import { visualReply } from "../src/providers/fakeVisuals.ts";
import type { Prompt, ProviderEvent, ProviderSession, SessionOptions, SessionSink } from "../src/providers/types.ts";
import { createThread, RpcFailure, runTurn, startTestBridge, streamedText, TestClient, unspent, type Frame, type TestBridge } from "./helpers.ts";

// The fake agent's scenarios end to end, through a client doing the app's handshake,
// checked against what the app reads (docs/gateway-protocol.md, sections 6, 7 and 9).

let bridge: TestBridge;
let client: TestClient;

before(async () => {
  bridge = await startTestBridge();
  client = await TestClient.open(bridge);
});

after(async () => {
  await client.close();
  await bridge.dispose();
});

function ofType(events: Frame[], type: string): Frame[] {
  return events.filter((event) => event.type === type);
}

async function withDroidFake(check: (client: TestClient) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "portals-fake-droid-"));
  const provider = new DroidParityFakeProvider({ directory, delayMs: 2 });
  const bridge = await startTestBridge({ providers: new Map([["fake", provider]]) });
  const client = await TestClient.open(bridge);
  try {
    await check(client);
  } finally {
    await client.close();
    await bridge.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Droid parity is opt-in and exposes all mode labels and the inherited Medium default", async () => {
  assert.equal((await client.call("profiles.list")).profiles[0].mode_options, undefined);
  await withDroidFake(async (client) => {
    const profile = (await client.call("profiles.list")).profiles[0];
    assert.deepEqual(profile.mode_options.map((mode: Frame) => [mode.id, mode.label]), [
      ["ask", "Off"], ["edits", "Low"], ["medium", "Medium"], ["full", "High"], ["plan", "Spec"], ["default", "Default"],
    ]);
    assert.deepEqual((await client.call("model.options", { profile: "fake" })).mode_options, profile.mode_options);
    const created = await client.call("session.create", { profile: "fake", source: "tui" });
    assert.equal(created.info.mode, "default");
    assert.equal(created.info.mode_default, "medium");
    const changed = await client.call("session.set_mode", { session_id: created.session_id, mode: "medium" });
    assert.equal(changed.mode, "medium");
    assert.deepEqual(changed.mode_options, profile.mode_options);
    const resumed = await client.call("session.resume", { session_id: created.session_id });
    assert.equal(resumed.info.mode, "medium");
    assert.equal(resumed.info.mode_default, "medium");
  });
});

test("Droid parity sends cumulative live output, usage, working states and structured todos", async () => {
  await withDroidFake(async (client) => {
    const session = await createThread(client);
    await client.call("prompt.submit", { session_id: session, profile: "fake", text: "droid-parity" });
    const first = await client.nextEvent("tool.progress", session);
    assert.equal(first.payload.output, "parity-first\n");
    const inflight = (await client.call("session.resume", { session_id: session })).inflight;
    assert.equal(inflight.tools[0].output, "parity-first\n");
    assert.deepEqual(inflight.turn_usage, { tokens: 120 });
    await client.nextEvent("message.complete", session);
    const events = client.events(session);
    assert.deepEqual(ofType(events, "tool.progress").map((event) => event.payload.output), ["parity-first\n", "parity-first\nparity-second\n"]);
    assert.ok(ofType(events, "tool.progress").every((event) => event.payload.output_truncated === false));
    assert.deepEqual(ofType(events, "message.usage").map((event) => event.payload.turn_usage), [{ tokens: 120 }, { tokens: 240 }]);
    assert.equal(events.at(-1).payload.turn_usage.tokens, 300);
    assert.deepEqual(ofType(events, "status.update").map((event) => event.payload.kind), ["working", "info", "working", "working"]);
    assert.deepEqual(ofType(events, "status.update").at(-1)?.payload, { kind: "working", state: "idle", text: "" });
    const tools = ofType(events, "tool.complete").map((event) => event.payload);
    const plans = tools.filter((tool) => tool.name === "todo");
    assert.deepEqual(plans[0].args.items.map((item: Frame) => item.status), ["completed", "in_progress", "pending"]);
    assert.match(plans[0].args.todos, /2\. \[in_progress\] Implement progress/);
    assert.ok(plans[1].args.items.every((item: Frame) => item.status === "completed"));
    const terminal = tools.find((tool) => tool.name === "terminal");
    assert.equal(terminal.args.riskLevel, "low");
    assert.equal(terminal.args.timeout, 30);
    assert.equal(terminal.args.fireAndForget, false);
    assert.equal(terminal.result.output, "parity-first\nparity-second\n");
    const history = (await client.call("session.resume", { session_id: session })).messages;
    assert.deepEqual(history.find((message: Frame) => message.name === "todo").args, plans[0].args);
    assert.equal(history.filter((message: Frame) => message.name === "terminal").length, 1);
  });
});

test("Droid parity optionally shows one synthetic non-stoppable background child beside its checklist", async () => {
  await withDroidFake(async (client) => {
    const session = await createThread(client);
    const events = await runTurn(client, session, "droid-parity subagents");
    const children = events.filter((event) => ["subagent.start", "subagent.complete"].includes(event.type)).map((event) => event.payload);
    assert.equal(children.length, 2);
    assert.deepEqual(children.map((child) => child.status), ["running", "completed"]);
    assert.match(children[0].subagent_id, /^parity-child-/);
    assert.equal(children[0].subagent_id, children[1].subagent_id);
    assert.equal(children[0].background, true);
    assert.equal(children[0].can_stop, false);
    assert.equal(children[1].can_stop, false);
    assert.match(children[1].result, /no child or tools ran/);
    assert.equal(ofType(events, "tool.complete").filter((event) => event.payload.name === "todo").length, 2);
  });
});

test("Droid parity asks both required questions, preserves their answers and accepts cancellation", async () => {
  await withDroidFake(async (client) => {
    for (const answers of [{ language: "Swift", checks: "UI tests" }, null]) {
      const session = await createThread(client);
      await client.call("prompt.submit", { session_id: session, profile: "fake", text: "droid-parity ask" });
      const request = await client.nextRequest();
      assert.equal(request.method, "clarify");
      assert.equal(request.params.requires_all_answers, true);
      assert.deepEqual(request.params.questions.map((question: Frame) => question.qid), ["language", "checks"]);
      client.answer(request.id, { answers });
      await client.nextEvent("message.complete", session);
      const clarify = ofType(client.events(session), "tool.complete").find((event) => event.payload.name === "clarify");
      assert.deepEqual(clarify?.payload.result.answers, answers);
    }
  });
});

test("Droid parity live output can be interrupted and keeps exactly one terminal row", async () => {
  await withDroidFake(async (client) => {
    const session = await createThread(client);
    await client.call("prompt.submit", { session_id: session, profile: "fake", text: "droid-parity" });
    await client.nextEvent("tool.progress", session);
    await client.call("session.interrupt", { session_id: session });
    const done = await client.nextEvent("message.complete", session);
    assert.equal(done.payload.status, "interrupted");
    assert.equal(ofType(client.events(session), "tool.start").filter((event) => event.payload.name === "terminal").length, 1);
  });
});

test("Droid parity rich approval keeps safe details and records a grant without executing it", async () => {
  await withDroidFake(async (client) => {
    const session = await createThread(client);
    await client.call("prompt.submit", { session_id: session, profile: "fake", text: "droid-parity approval" });
    const request = await client.nextRequest();
    assert.equal(request.method, "approval");
    const file = request.params.options.find((option: Frame) => option.id === "proceed_always_file");
    assert.equal(file.requires_confirmation, true);
    assert.equal(file.effects[0].scope, "settings");
    assert.match(file.description, /exact scratch file/);
    assert.match(request.params.details[0].diff, /-hi\n\+hello\n/);
    assert.equal(request.params.details[2].server, "parity-server");
    assert.equal(request.params.details[3].violation_type, "filesystem");
    assert.equal(request.params.details[4].findings[0].title, "Scripted finding");
    client.answer(request.id, { option: file.id });
    const done = await client.nextEvent("message.complete", session);
    assert.match(done.payload.text, /proceed_always_file\. Nothing executed/);
    const tool = ofType(client.events(session), "tool.complete").at(-1);
    assert.deepEqual(tool?.payload.result, { answer: { kind: "approval.option", option: file.id }, executed: false });
    assert.equal((await client.call("session.events.since", { session_id: session, last_seen: 0 })).open_requests.length, 0);
  });
});

test("Droid parity limited approvals offer no broad grants and Spec edits round-trip without starting work", async () => {
  await withDroidFake(async (client) => {
    for (const plan of [false, true]) {
      const session = await createThread(client);
      await client.call("prompt.submit", { session_id: session, profile: "fake", text: `droid-parity ${plan ? "plan" : "approval limited"}` });
      const request = await client.nextRequest();
      if (plan) {
        assert.match(request.params.plan_content, /^# Parity plan/);
        assert.equal(request.params.plan, true);
        assert.equal(request.params.starts_in, "ask");
        assert.ok(request.params.options.some((option: Frame) => option.id === "proceed_new_session_high"));
        client.answer(request.id, { option: "proceed_edit", edited_plan: "# Revised plan\n\nOnly inspect.\n" });
      } else {
        assert.deepEqual(request.params.options.map((option: Frame) => option.id), ["proceed_once", "cancel"]);
        client.answer(request.id, { option: "cancel" });
      }
      const done = await client.nextEvent("message.complete", session);
      assert.match(done.payload.text, /Nothing executed/);
      const result = ofType(client.events(session), "tool.complete").at(-1)?.payload.result;
      assert.equal(result.executed, false);
      if (plan) assert.equal(result.answer.editedPlan, "# Revised plan\n\nOnly inspect.\n");
      else assert.equal(result.answer.option, "cancel");
    }
  });
});

test("Droid parity offers no Spec model of its own, and an older app's session.set_spec_model changes nothing", async () => {
  await withDroidFake(async (client) => {
    const created = await client.call("session.create", { profile: "fake", source: "tui" });
    const session_id = created.session_id;
    assert.equal(created.info.spec_model, undefined);
    assert.deepEqual(await client.call("session.set_spec_model", { session_id, model: "fake-2", reasoning_effort: "high" }),
      { spec_model: "default", spec_reasoning_effort: "", deferred: false });
    const info = (await client.call("session.resume", { session_id })).info;
    assert.equal(info.model, "fake-1");
    assert.equal(info.spec_model, undefined);
  });
});

test("a reply streams word by word between message.start and message.complete", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "hello there");
  assert.equal(events[0].type, "message.start");
  // The message that opened the turn, for every device that follows the thread (feature turn_messages).
  assert.deepEqual(events[0].payload, { text: "hello there", sender: "user" });
  const complete = events.at(-1);
  assert.equal(complete.type, "message.complete");
  assert.equal(complete.payload.status, "complete");
  assert.equal(complete.payload.text, "Hello from the fake agent. You said: hello there.");
  assert.equal(streamedText(events), complete.payload.text);
  assert.ok(ofType(events, "message.delta").length > 5);
  assert.ok(complete.payload.usage.context_used > 1000);
  assert.equal(complete.payload.usage.context_max, 200_000);
  assert.deepEqual(ofType(events, "session.title").map((event) => event.payload), [{ title: "Fake: hello there" }]);

  // Every event carries the session and the next number.
  assert.ok(events.every((event) => event.session_id === session));
  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
  );
  // The title is given once.
  const second = await runTurn(client, session, "again");
  assert.equal(ofType(second, "session.title").length, 0);
  assert.equal(second[0].seq, events.at(-1).seq + 1);
});

test("think streams reasoning before the reply", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "think about it");
  const firstReasoning = events.findIndex((event) => event.type === "reasoning.delta");
  const firstText = events.findIndex((event) => event.type === "message.delta");
  assert.ok(firstReasoning > 0 && firstReasoning < firstText);
  assert.equal(streamedText(events, "reasoning.delta"), "The user wants me to think first. I will keep the answer short.");
  const stored = (await client.call("session.resume", { session_id: session })).messages.at(-1);
  assert.equal(stored.reasoning, "The user wants me to think first. I will keep the answer short.");
});

test("steps works with thoughts between its tool calls, three of them at once", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "show the steps");
  // What the app's one line for the work under way is checked against: thoughts that
  // stream, then tools; tools running together; then the reply.
  const shape = events
    .filter((event) => event.type === "reasoning.delta" || event.type.startsWith("tool.") || event.type === "message.delta")
    .map((event) => (event.type.startsWith("tool.") ? `${event.type}:${event.payload.name}` : event.type))
    .filter((kind, index, all) => kind !== all[index - 1] || kind.startsWith("tool."));
  assert.deepEqual(shape, [
    "reasoning.delta",
    "tool.start:terminal",
    "tool.complete:terminal",
    "tool.start:search_files",
    "tool.start:search_files",
    "tool.start:search_files",
    "tool.complete:search_files",
    "tool.complete:search_files",
    "tool.complete:search_files",
    "reasoning.delta",
    "tool.start:read_file",
    "tool.complete:read_file",
    "reasoning.delta",
    "tool.start:patch",
    "tool.complete:patch",
    "message.delta",
  ]);
  assert.match(streamedText(events, "reasoning.delta"), /^\*\*Finding the slow test\*\*/);
  assert.equal(events.at(-1).payload.status, "complete");
});

test("steps with bursts sends its first thought in bursts and its second whole", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "show the steps in bursts");
  // The thoughts between the tool calls, each as the pieces it came in.
  const thoughts: string[][] = [];
  let previous = "";
  for (const event of events) {
    if (event.type === "reasoning.delta") {
      if (previous !== "reasoning.delta") thoughts.push([]);
      thoughts.at(-1)!.push(event.payload.text);
    }
    if (event.type === "reasoning.delta" || event.type.startsWith("tool.") || event.type === "message.delta") previous = event.type;
  }
  assert.equal(thoughts.length, 3);
  assert.ok(thoughts[0].length > 2 && thoughts[0].every((piece) => piece.length <= 80), "bursts of about seventy characters");
  assert.match(thoughts[0].join(""), /^\*\*Finding the slow test\*\*/);
  assert.equal(thoughts[1].length, 1, "the second whole at once");
  assert.ok(thoughts[2].length > 3, "the third word by word");
  assert.equal(events.at(-1).payload.status, "complete");
});

test("tool makes an edit with a diff and runs a command, in the shapes the app styles", async () => {
  // The bridge keeps the folder's real path (/private/var/… for /var/…).
  const cwd = realpathSync(tmpdir());
  const session = await createThread(client, { cwd });
  const events = await runTurn(client, session, "use a tool please");
  const tools = events.filter((event) => event.type.startsWith("tool."));
  assert.deepEqual(
    tools.map((event) => [event.type, event.payload.name]),
    [
      ["tool.start", "patch"],
      ["tool.complete", "patch"],
      ["tool.start", "terminal"],
      ["tool.complete", "terminal"],
    ],
  );
  const path = join(cwd, "hello.txt");
  const [editStart, edit, runStart, run] = tools.map((event) => event.payload);
  assert.deepEqual(editStart, { tool_id: edit.tool_id, name: "patch", args: { path, old_string: "hi", new_string: "hello" } });
  // The finish repeats name and args: after a reconnect the app may not have seen the start.
  assert.deepEqual(edit.args, editStart.args);
  assert.deepEqual(edit.result, { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n" });
  assert.equal(edit.duration_s, 0.12);
  assert.deepEqual(runStart.args, { command: "cat hello.txt" });
  assert.deepEqual(run.result, { output: "hello\n", exit_code: 0 });

  // The text before the tools streams; message.complete carries only the reply after them.
  const before = events.slice(0, events.indexOf(tools[0]));
  assert.equal(streamedText(before), "I'll change hi to hello in hello.txt. ");
  assert.equal(events.at(-1).payload.text, "Hello from the fake agent. You said: use a tool please.");

  // Stored the way a resume returns it: tool rows from tool messages, results as JSON text.
  const messages = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(messages[0], { role: "user", text: "use a tool please", timestamp: messages[0].timestamp });
  assert.deepEqual(messages[1].text, "I'll change hi to hello in hello.txt. ");
  assert.deepEqual(
    { ...messages[2], timestamp: 0 },
    { role: "tool", name: "patch", args: editStart.args, content: JSON.stringify(edit.result), tool_call_id: edit.tool_id, timestamp: 0 },
  );
  assert.deepEqual(JSON.parse(messages[3].content), { output: "hello\n", exit_code: 0 });
  assert.equal(messages[4].role, "assistant");
  assert.equal(messages[4].text, "Hello from the fake agent. You said: use a tool please.");
  assert.ok(messages.every((message: Frame) => typeof message.timestamp === "number"));
});

test("bench instant gives a long reply like a real agent's at once: headings, lists, code, a table, math, and tool calls with diffs and output", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "bench instant");
  const tools = events.filter((event) => event.type === "tool.complete").map((event) => event.payload);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["read", "patch", "terminal", "read", "patch", "terminal", "read", "patch", "terminal"],
  );
  assert.ok(tools.filter((tool) => tool.name === "patch").every((tool) => tool.result.diff.startsWith("--- a/Sources/Engine/Part")));
  assert.ok(tools.filter((tool) => tool.name === "terminal").every((tool) => /Executed 12 tests/.test(tool.result.output)));
  const text = streamedText(events);
  for (const piece of ["## Part 1", "1. **The entry point**", "   - The hash itself", "```swift", "| Input | Pieces |", "$\\sum_{k=1}^{n}", "$$\\text{speedup}", "## Summary"]) {
    assert.ok(text.includes(piece), `the reply has ${piece}`);
  }
  // At once: each paragraph in one piece, not word by word.
  assert.equal(events.filter((event) => event.type === "message.delta").length, benchSteps(0).filter((step) => step.kind === "text").length);
  assert.equal(events.at(-1).payload.status, "complete");
});

/** The bench reply as played, on a clock that moves only when the player waits. */
async function playedBench(round: number, mode: { instant?: boolean; coarse?: boolean } = {}) {
  let clock = 0;
  let calls = 0;
  const events: { at: number; event: ProviderEvent }[] = [];
  const waits: number[] = [];
  const player: BenchPlayer = {
    emit: (event) => events.push({ at: clock, event }),
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    toolID: () => `call-${(calls += 1)}`,
  };
  await playBench(player, round, mode.instant ?? false, mode.coarse ?? false);
  const texts = events.flatMap(({ event }) => (event.type === "text" ? [event.text] : []));
  const toolStarts = events.filter(({ event }) => event.type === "tool.start").map(({ at }) => at);
  return { events, waits, texts, toolStarts, ms: clock };
}

const benchText = (round: number) => benchSteps(round).map((step) => (step.kind === "text" ? step.text : "")).join("");

test("bench plays its reply in pieces of 2 to 14 characters with a pause of 30 to 80 ms after each, for about a minute, the same every time", async () => {
  const played = await playedBench(3);
  assert.equal(played.texts.join(""), benchText(3));
  assert.ok(played.texts.every((piece) => piece.length >= 1 && piece.length <= 14));
  assert.ok(played.texts.filter((piece) => piece.length < 2).length <= benchSteps(3).filter((step) => step.kind === "text").length, "only a paragraph's last piece is shorter than 2");
  // Each piece is followed by its pause; the tool calls' own waits are longer or 120 ms.
  const textPauses = played.events.flatMap(({ event }, index) =>
    event.type === "text" ? [(played.events[index + 1]?.at ?? played.ms) - played.events[index].at] : [],
  );
  assert.ok(textPauses.every((pause) => pause >= 30 && pause <= 80), `pauses ${Math.min(...textPauses)}–${Math.max(...textPauses)} ms`);
  assert.ok(played.ms > 50_000 && played.ms < 120_000, `${played.ms} ms`);
  assert.deepEqual(await playedBench(3), played);
  assert.notDeepEqual((await playedBench(4)).waits, played.waits);
});

test("bench coarse sends the same text on the same schedule in half as many pieces: each two pieces as one, after both their pauses", async () => {
  for (const round of [3, 18]) {
    const fine = await playedBench(round);
    const coarse = await playedBench(round, { coarse: true });
    assert.equal(coarse.texts.join(""), fine.texts.join(""));
    // Half as many, give or take a paragraph's odd last piece.
    const paragraphs = benchSteps(round).filter((step) => step.kind === "text").length;
    assert.ok(coarse.texts.length >= fine.texts.length / 2 && coarse.texts.length <= Math.ceil(fine.texts.length / 2) + paragraphs, `${fine.texts.length} → ${coarse.texts.length}`);
    // The same schedule: the reply takes as long, and every tool call starts at the same time.
    assert.equal(coarse.ms, fine.ms);
    assert.deepEqual(coarse.toolStarts, fine.toolStarts);
  }
});

test("bench instant sends each paragraph at once and never waits", async () => {
  const played = await playedBench(3, { instant: true });
  assert.deepEqual(played.waits, []);
  assert.deepEqual(played.texts, benchSteps(3).flatMap((step) => (step.kind === "text" ? [step.text] : [])));
});

test("visual replies with a visual whose fence arrives whole, passing through a part with the fence still open", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "visual please");
  const text = events.at(-1).payload.text as string;
  assert.equal(text, visualReply("visual please"));
  assert.match(text, /^Move the sliders[^\n]*\n\n```portals-visual title="Savings over ten years"\n<div class="calc">\n/);
  assert.match(text, /\n<\/script>\n```\n\nA higher rate/);
  // Some streamed part ends inside the visual: what the app draws as it is written.
  let streamed = "";
  const prefixes = ofType(events, "message.delta").map((event) => (streamed += event.payload.text));
  assert.ok(prefixes.some((prefix) => prefix.includes("```portals-visual") && !prefix.includes("</script>\n```")));
  assert.equal(streamed, text);
});

test("the visual words pick a visual, also under the name they had at first, and unclosed ends inside one", () => {
  assert.equal(visualReply("hello"), null);
  assert.equal(visualReply("widget"), visualReply("visual"));
  const fences = (text: string) => text.match(/^```portals-visual title="[^"]+"$/gm)?.length ?? 0;
  const closes = (text: string) => text.match(/^```$/gm)?.length ?? 0;
  for (const [words, count] of [["visual", 1], ["visual cdn", 1], ["visual tall", 1], ["visual escape", 1], ["visuals many", 5]] as const) {
    const text = visualReply(words)!;
    assert.equal(fences(text), count, words);
    assert.equal(closes(text), count, words);
  }
  assert.match(visualReply("visual cdn")!, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@4\/dist\/chart\.umd\.min\.js"><\/script>/);
  const unclosed = visualReply("visual unclosed")!;
  assert.equal(fences(unclosed), 1);
  assert.equal(closes(unclosed), 0);
});

test("approve asks before running, and an allowed command runs", async () => {
  const session = await createThread(client);
  await client.call("prompt.submit", { session_id: session, text: "approve this", profile: "fake" });
  const request = await client.nextRequest();
  assert.equal(request.method, "approval");
  assert.equal(request.params.description, "delete a folder (the fake agent only pretends)");
  client.answer(request.id, { choice: "once" });
  const done = await client.nextEvent("message.complete", session);
  assert.match(done.payload.text, /^The command ran\./);
  const run = client.events(session).find((event) => event.type === "tool.complete");
  assert.deepEqual(run.payload.result, { output: "Pretended to delete ./fake-build.", exit_code: 0 });
  // The answer closed the card here; the log tells anyone else.
  assert.equal(client.events(session).filter((event) => event.type === "request.cancel").length, 0);
  const logged = await client.call("session.events.since", { session_id: session, last_seen: 0 });
  assert.deepEqual(logged.events.find((event: Frame) => event.type === "request.cancel").payload, { id: request.id, reason: "resolved" });
});

test("a denied command is stored as blocked, so history shows it truthfully", async () => {
  const session = await createThread(client);
  await client.call("prompt.submit", { session_id: session, text: "approve this", profile: "fake" });
  const request = await client.nextRequest();
  // An error answer ("Not supported by this client") counts as a no.
  client.send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Not supported by this client" } });
  await client.nextEvent("message.complete", session);
  const tool = (await client.call("session.resume", { session_id: session })).messages.find((message: Frame) => message.role === "tool");
  assert.deepEqual(JSON.parse(tool.content), { status: "blocked", error: "Denied by the user.", user_summary: "You denied this command — it did not run." });
});

test("a no with a note, to an agent that takes neither notes nor messages mid-turn: the note waits, then has a turn of its own", async () => {
  const session = await createThread(client);
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: session, text: "approve this", profile: "fake" });
  const request = await client.nextRequest();
  client.answer(request.id, { choice: "deny", note: "Delete ./old-build instead." });
  await client.from(start, () => client.events(session).filter((event) => event.type === "message.complete").length === 2, 15_000);
  const events = client.events(session);
  assert.match(ofType(events, "message.complete")[0].payload.text, /^You said no, so nothing ran\./);
  // Listed for every device while it waits, and named by the turn it opens.
  assert.deepEqual(ofType(events, "queue.changed")[0].payload.queued, [{ id: "1", text: "Delete ./old-build instead." }]);
  assert.deepEqual(ofType(events, "message.start").map((event) => event.payload?.queue_id), [undefined, "1"]);
  assert.match(ofType(events, "message.complete")[1].payload.text, /You said: Delete \.\/old-build instead\.$/);
  const messages = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(
    messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text),
    ["approve this", "Delete ./old-build instead."],
  );
  // A plain no says nothing more.
  const plain = client.frames.length;
  await client.call("prompt.submit", { session_id: session, text: "approve this", profile: "fake" });
  client.answer((await client.nextRequest()).id, { choice: "deny" });
  await client.from(plain, (frame) => frame.method === "event" && frame.params.type === "message.complete" && frame.params.session_id === session);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ofType(client.events(session).slice(events.length), "message.start").length, 1);
});

/** The scripted agent, asking for approval once a turn has ended, as a background agent of Claude's can. */
class AsksAfterItsTurn extends FakeProvider {
  override async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    const session = await super.startSession(options, sink);
    const start = session.startTurn.bind(session);
    return Object.assign(session, {
      startTurn(prompt: Prompt): void {
        if (prompt.text !== "ask after your turn") return start(prompt);
        sink.emit({ type: "text", text: "Done for now." });
        sink.emit({ type: "turn.end", status: "complete" });
        void sink.ask({ kind: "approval", command: "rm -rf ./cache", choices: ["once", "deny"] });
      },
    });
  }
}

test("a no with a note to a question asked outside any turn opens a turn of its own, which every device opens with the note", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "portals-fake-"));
  const own = await startTestBridge({ providers: new Map([["fake", new AsksAfterItsTurn({ directory, delayMs: 1 })]]) });
  const phone = await TestClient.open(own);
  t.after(async () => {
    await phone.close();
    await own.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  const session = await createThread(phone);
  const start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "ask after your turn", profile: "fake" });
  const request = await phone.nextRequest();
  await phone.from(start, (frame) => frame.method === "event" && frame.params.type === "message.complete" && frame.params.session_id === session);
  phone.answer(request.id, { choice: "deny", note: "Clear ./tmp instead." });
  await phone.from(start, () => phone.events(session).filter((event) => event.type === "message.complete").length === 2, 15_000);
  const events = phone.events(session);
  assert.deepEqual(ofType(events, "message.start").map((event) => event.payload), [
    { text: "ask after your turn", sender: "user" },
    // The note is the user's; an app without the feature turn_messages shows it as one sent through Portals.
    { opened_by: "portals", text: "Clear ./tmp instead.", sender: "user" },
  ]);
  assert.match(ofType(events, "message.complete")[1].payload.text, /You said: Clear \.\/tmp instead\.$/);
  assert.deepEqual(ofType(events, "queue.changed"), []);
});

test("ask puts a question; the answer comes back in the reply and in history", async () => {
  const session = await createThread(client);
  await client.call("prompt.submit", { session_id: session, text: "ask me", profile: "fake" });
  const request = await client.nextRequest();
  assert.equal(request.method, "clarify");
  client.answer(request.id, { answers: { q0: "Swift" } });
  const done = await client.nextEvent("message.complete", session);
  assert.match(done.payload.text, /^You chose Swift\./);
  // The clarify tool call is there for the app to skip; history keeps the answer.
  const events = client.events(session);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("tool.")).map((event) => event.payload.name),
    ["clarify", "clarify"],
  );
  const stored = (await client.call("session.resume", { session_id: session })).messages.find((message: Frame) => message.name === "clarify");
  assert.deepEqual(stored.args, { questions: [{ question: "Which language should I use?", choices: ["Python", "Swift"] }] });
  assert.equal(JSON.parse(stored.content).responses[0].user_response, "Swift");
});

test("a cancelled question is skipped", async () => {
  const session = await createThread(client);
  await client.call("prompt.submit", { session_id: session, text: "ask me", profile: "fake" });
  const request = await client.nextRequest();
  client.answer(request.id, {});
  const done = await client.nextEvent("message.complete", session);
  assert.match(done.payload.text, /^You skipped the question/);
});

test("slow can be interrupted, and the turn still ends with message.complete", async () => {
  const session = await createThread(client);
  await client.call("prompt.submit", { session_id: session, text: "slow please", profile: "fake" });
  await client.nextEvent("message.delta", session);
  assert.deepEqual(await client.call("session.interrupt", { session_id: session, profile: "fake" }), { status: "interrupted" });
  const done = await client.nextEvent("message.complete", session);
  assert.equal(done.payload.status, "interrupted");
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "not_interrupted" });
  const reply = (await client.call("session.resume", { session_id: session })).messages.at(-1);
  assert.equal(reply.role, "assistant");
  assert.deepEqual(reply.display_metadata, { interrupted: true });
});

test("interrupting withdraws an open question", async () => {
  const session = await createThread(client);
  await client.call("prompt.submit", { session_id: session, text: "approve this", profile: "fake" });
  const request = await client.nextRequest();
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const cancel = await client.nextEvent("request.cancel", session);
  assert.deepEqual(cancel.payload, { id: request.id, reason: "interrupted" });
  const done = await client.nextEvent("message.complete", session);
  assert.equal(done.payload.status, "interrupted");
  // Too late now.
  client.answer(request.id, { choice: "once" });
  const since = await client.call("session.events.since", { session_id: session, last_seen: 0 });
  assert.deepEqual(since.open_requests, []);
});

test("a message sent while a turn runs is queued and runs next", async () => {
  const session = await createThread(client);
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: session, text: "slow please", profile: "fake" });
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text: "second message", profile: "fake" }), { status: "queued", queue_id: "1" });
  await client.from(start, () => client.events(session).filter((event) => event.type === "message.complete").length === 2, 15_000);
  const events = client.events(session);
  assert.equal(ofType(events, "message.start").length, 2);
  const secondStart = events.findLastIndex((event) => event.type === "message.start");
  assert.match(streamedText(events.slice(secondStart)), /You said: second message\.$/);
  const messages = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(
    messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text),
    ["slow please", "second message"],
  );
});

test("messages waiting are listed for every device, the turn each opens names it, and one taken off the list is never sent", async () => {
  const session = await createThread(client);
  const other = await TestClient.open(bridge);
  try {
    await other.call("session.resume", { session_id: session });
    const start = client.frames.length;
    await client.call("prompt.submit", { session_id: session, text: "slow please", profile: "fake" });
    const submit = (text: string, when_busy?: string) => client.call("prompt.submit", { session_id: session, text, profile: "fake", when_busy });
    // The fake agent cannot take a message into a running turn: steer or queue, it waits.
    assert.deepEqual(await submit("first waiting", "queue"), { status: "queued", queue_id: "1" });
    assert.deepEqual(await submit("second waiting", "steer"), { status: "queued", queue_id: "2" });
    assert.deepEqual(await submit("third waiting"), { status: "queued", queue_id: "3" });
    await assert.rejects(submit("fourth", "later"), (error: RpcFailure) => error.code === -32602);
    const resumed = await other.call("session.resume", { session_id: session });
    assert.deepEqual(resumed.queued, [
      { id: "1", text: "first waiting" },
      { id: "2", text: "second waiting" },
      { id: "3", text: "third waiting" },
    ]);
    assert.equal(resumed.can_steer, false);

    assert.deepEqual(await client.call("prompt.queue.remove", { session_id: session, queue_id: "2" }), { removed: true });
    assert.deepEqual(await client.call("prompt.queue.remove", { session_id: session, queue_id: "2" }), { removed: false });
    assert.deepEqual(await client.call("prompt.queue.steer", { session_id: session, queue_id: "1" }), { status: "queued" });
    assert.deepEqual(await client.call("prompt.queue.steer", { session_id: session, queue_id: "9" }), { status: "gone" });

    await client.from(start, () => client.events(session).filter((event) => event.type === "message.complete").length === 3, 15_000);
    const events = client.events(session);
    assert.deepEqual(
      ofType(events, "message.start").map((event) => event.payload?.queue_id),
      [undefined, "1", "3"],
    );
    // Each list as it changed: three waiting, the one taken off, then one by one as their turns open.
    assert.deepEqual(
      ofType(events, "queue.changed").map((event) => event.payload.queued.map((queued: Frame) => queued.id)),
      [["1"], ["1", "2"], ["1", "2", "3"], ["1", "3"], ["3"], []],
    );
    // A turn's start comes before the list without its message.
    const opened = events.findIndex((event) => event.type === "message.start" && event.payload?.queue_id === "1");
    const left = events.findIndex((event) => event.type === "queue.changed" && event.payload.queued.length === 1 && event.payload.queued[0].id === "3");
    assert.ok(opened < left);
    const messages = (await client.call("session.resume", { session_id: session })).messages;
    assert.deepEqual(
      messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text),
      ["slow please", "first waiting", "third waiting"],
    );
    // The other device was told too.
    await other.from(0, () => other.events(session).some((event) => event.type === "queue.changed" && event.payload.queued.length === 0) || undefined!);
  } finally {
    await other.close();
  }
});

test("a file of any kind is saved in the thread's folder, left out of git, and named in the message by its path", async () => {
  const session = await createThread(client);
  const cwd = (await client.call("session.resume", { session_id: session })).info.cwd as string;
  const attach = (filename: string, text: string) => client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.from(text).toString("base64"), filename, profile: "fake" });
  const notes = await attach("notes.txt", "first");
  const again = await attach("notes.txt", "second");
  const sneaky = await attach("../../.env", "SECRET=1");
  const folder = join(cwd, ".portals", "files", session);
  assert.deepEqual(notes, { attached: true, name: "notes.txt", path: join(folder, "notes.txt") });
  assert.deepEqual(again, { attached: true, name: "notes 2.txt", path: join(folder, "notes 2.txt") });
  // Only a name: no folder from the device is used, and nothing is hidden.
  assert.deepEqual(sneaky, { attached: true, name: "env", path: join(folder, "env") });
  assert.equal(readFileSync(join(folder, "notes 2.txt"), "utf8"), "second");
  assert.equal(readFileSync(join(cwd, ".portals", ".gitignore"), "utf8"), "*\n");

  const events = await runTurn(client, session, "read these");
  assert.equal(events.at(-1).payload.status, "complete");
  const user = (await client.call("session.resume", { session_id: session })).messages[0];
  assert.equal(user.text, `read these\n\nFiles attached in Portals (saved on this Mac):\n- ${notes.path}\n- ${again.path}\n- ${sneaky.path}`);

  // A message of files alone is allowed.
  const report = await attach("report.pdf", "%PDF-1.7");
  assert.equal((await runTurn(client, session, "")).at(-1).payload.status, "complete");
  const alone = (await client.call("session.resume", { session_id: session })).messages.filter((message: Frame) => message.role === "user").at(-1);
  assert.equal(alone.text, `Files attached in Portals (saved on this Mac):\n- ${report.path}`);

  // At most ten wait for one message.
  for (let index = 0; index < 10; index += 1) assert.equal((await attach(`f${index}.txt`, "x")).attached, true);
  const eleventh = await attach("f10.txt", "x");
  assert.equal(eleventh.attached, false);
  assert.match(eleventh.message, /At most 10 files/);
});

test("files go with the next message of the device that attached them, and another device's message takes none of them", async () => {
  const session = await createThread(client);
  const other = await TestClient.open(bridge);
  try {
    await other.call("session.resume", { session_id: session });
    const attached = await client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.from("mine").toString("base64"), filename: "mine.txt", profile: "fake" });
    // The other device sends first: its message is its own words alone.
    const start = other.frames.length;
    assert.equal((await other.call("prompt.submit", { session_id: session, text: "from the Mac", profile: "fake" })).status, "streaming");
    await other.from(start, () => other.events(session).some((event) => event.type === "message.complete") || undefined!);
    assert.equal((await runTurn(client, session, "read mine")).at(-1).payload.status, "complete");
    const users = (await client.call("session.resume", { session_id: session })).messages.filter((message: Frame) => message.role === "user");
    assert.deepEqual(users.map((message: Frame) => message.text), [
      "from the Mac",
      `read mine\n\nFiles attached in Portals (saved on this Mac):\n- ${attached.path}`,
    ]);
    // Nor can it send attachments that are not its own as a message of their own.
    await client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.from("x").toString("base64"), filename: "x.txt", profile: "fake" });
    await assert.rejects(other.call("prompt.submit", { session_id: session, text: "", profile: "fake" }), (error: RpcFailure) => error.code === -32602);
  } finally {
    await other.close();
  }
});

test("a send tried again after it failed half way carries each file once", async () => {
  const session = await createThread(client);
  const attach = (filename: string, id: string) =>
    client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.from(filename).toString("base64"), filename, id, profile: "fake" });
  // Attached again with the same id, as after a reply that never came: the file it was.
  const first = await attach("a.txt", "file-a");
  assert.deepEqual(await attach("a.txt", "file-a"), first);
  // A file turned down fails the message: nothing attached for it waits on, images included.
  await attach("b.txt", "file-b");
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  await client.call("image.attach_bytes", { session_id: session, content_base64: png, filename: "photo.png", profile: "fake" });
  const large = await client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64"), filename: "large.bin", profile: "fake" });
  assert.deepEqual(large, { attached: false, message: "large.bin is larger than 25 MB." });
  await assert.rejects(client.call("prompt.submit", { session_id: session, text: "", profile: "fake" }), (error: RpcFailure) => error.code === -32602);
  // Tried again whole: each once, also when sent again before the first answer came.
  const [again, twice] = await Promise.all([attach("a.txt", "file-a"), attach("a.txt", "file-a")]);
  assert.deepEqual(twice, again);
  const b = await attach("b.txt", "file-b");
  const events = await runTurn(client, session, "both");
  assert.match(events.at(-1).payload.text, /I got 2 files\.$/);
  // A file being saved when another is turned down is not attached either.
  const [late, refusedAgain] = await Promise.all([
    attach("late.txt", "file-late"),
    client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64"), filename: "large.bin", profile: "fake" }),
  ]);
  // Saved before the other was turned down, or after (and then its answer says so).
  assert.equal(typeof late.attached, "boolean");
  assert.equal(refusedAgain.attached, false);
  await assert.rejects(client.call("prompt.submit", { session_id: session, text: "", profile: "fake" }), (error: RpcFailure) => error.code === -32602);
  const user = (await client.call("session.resume", { session_id: session })).messages.find((message: Frame) => message.role === "user");
  assert.equal(user.text, `both\n\nFiles attached in Portals (saved on this Mac):\n- ${again.path}\n- ${b.path}`);
});

test("files sent at once find room for ten, and the one past them fails their message", async () => {
  const session = await createThread(client);
  const answers = await Promise.all(
    Array.from({ length: 11 }, (_, index) =>
      client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.from(`${index}`).toString("base64"), filename: `f${index}.txt`, profile: "fake" })),
  );
  // The eleventh is turned down; of the ten, those whose saves end after that say they are not attached.
  assert.match(answers[10].message, /At most 10 files/);
  assert.equal(answers.filter((answer) => answer.message?.startsWith("f") && /turned down meanwhile/.test(answer.message)).length + answers.filter((answer) => answer.attached === true).length, 10);
  // Turned down, it takes the others with it, saved or still being saved: the device sends them all again.
  await assert.rejects(client.call("prompt.submit", { session_id: session, text: "", profile: "fake" }), (error: RpcFailure) => error.code === -32602);
  for (let index = 0; index < 10; index += 1) {
    await client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.from(`${index}`).toString("base64"), filename: `f${index}.txt`, profile: "fake" });
  }
  const events = await runTurn(client, session, "all of them");
  assert.match(events.at(-1).payload.text, /I got 10 files\.$/);
});

test("images are queued on the session and go with the next message", async () => {
  const session = await createThread(client);
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  assert.deepEqual(await client.call("image.attach_bytes", { session_id: session, content_base64: png, filename: "../../etc/photo.png", profile: "fake" }), {
    attached: true,
    name: "photo.png",
  });
  assert.deepEqual(await client.call("image.attach_bytes", { session_id: session, content_base64: png, filename: "notes.pdf" }), {
    attached: false,
    message: "Only JPEG, PNG, GIF, WebP and HEIC images can be attached.",
  });
  // A message of only images is allowed.
  const events = await runTurn(client, session, "");
  assert.match(events.at(-1).payload.text, /I got one image\.$/);
  const user = (await client.call("session.resume", { session_id: session })).messages[0];
  assert.equal(user.text, "@image:photo.png");

  // Without images, an empty message is refused.
  await assert.rejects(client.call("prompt.submit", { session_id: session, text: "  " }), (error: RpcFailure) => error.code === -32602);
});

test("fail ends the turn with an error the app shows, and history marks it failed", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "please fail");
  assert.deepEqual(unspent(events.at(-1).payload), {
    status: "error",
    text: "The fake agent failed on purpose.",
    error_surface: { retryable: true },
  });
  const last = (await client.call("session.resume", { session_id: session })).messages.at(-1);
  // What the turn spent goes with its last message, as it went with its end.
  assert.deepEqual(last.turn_usage, events.at(-1).payload.turn_usage);
  assert.deepEqual({ ...unspent(last), timestamp: 0 }, { role: "assistant", text: "The fake agent failed on purpose.", display_kind: "failed_turn", timestamp: 0 });
});

test("a message.complete follows every message.start, whatever happened", async () => {
  const session = await createThread(client);
  for (const text of ["hello", "please fail", "think tool"]) await runTurn(client, session, text);
  const events = client.events(session);
  assert.equal(ofType(events, "message.start").length, 3);
  assert.equal(ofType(events, "message.complete").length, 3);
  assert.deepEqual(
    ofType(events, "message.complete").map((event) => event.payload.status),
    ["complete", "error", "complete"],
  );
});

// Questions an agent asks without waiting (Codex's request_user_input_async, feature async_questions).

async function withAsyncClient(check: (client: TestClient) => Promise<void>): Promise<void> {
  const asks = await TestClient.open(bridge, { capabilities: { async_questions: true, subagent_requests: true } });
  try {
    await check(asks);
  } finally {
    await asks.close();
  }
}

test("a question asked without waiting is a card that outlives the turn, and its answer opens a turn as the person's message", async () => {
  await withAsyncClient(async (client) => {
    const session = await createThread(client);
    await client.call("prompt.submit", { session_id: session, text: "meanwhile please", profile: "fake" });
    const request = await client.nextRequest();
    assert.equal(request.method, "clarify");
    assert.equal(request.params.async, true);
    assert.deepEqual(request.params.questions, [{ qid: "q0", question: "Which colour should the README heading use?", choices: ["Red", "Green", "Blue"], multi_select: false }]);
    const done = await client.nextEvent("message.complete", session);
    // The questions are the card's, not the reply's words.
    assert.doesNotMatch(done.payload.text, /README heading/);
    assert.match(done.payload.text, /go on with the rest meanwhile/);
    // Still open after the turn's end.
    const open = (await client.call("session.events.since", { session_id: session, last_seen: 0 })).open_requests;
    assert.deepEqual(open.map((entry: Frame) => entry.id), [request.id]);
    assert.equal((await client.call("sessions.activity")).sessions.find((entry: Frame) => entry.session_id === session)?.state, "waiting");

    client.answer(request.id, { answers: { q0: "Green" } });
    const start = await client.nextEvent("message.start", session);
    assert.equal(start.payload.text, "Green");
    const answered = await client.nextEvent("message.complete", session);
    assert.match(answered.payload.text, /You said: Green\./);
    const messages = (await client.call("session.resume", { session_id: session })).messages;
    const row = messages.findIndex((message: Frame) => message.name === "clarify");
    assert.deepEqual(messages[row].args, { questions: [{ question: "Which colour should the README heading use?", choices: ["Red", "Green", "Blue"] }], async: true });
    assert.deepEqual(JSON.parse(messages[row].content), { responses: [{ question: "Which colour should the README heading use?", user_response: "Green" }] });
    // Where it was asked, in the turn that asked it, before the answer's own turn.
    assert.deepEqual(messages.slice(row + 1).map((message: Frame) => [message.role, message.text]), [
      ["assistant", "I'll go on with the rest meanwhile. Hello from the fake agent. You said: meanwhile please."],
      ["user", "Green"],
      ["assistant", "Hello from the fake agent. You said: Green."],
    ]);
  });
});

test("a question asked without waiting is the reply's text where no device keeps such a card", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "meanwhile please");
  const done = events.find((event) => event.type === "message.complete")!;
  assert.match(done.payload.text, /Which colour should the README heading use\?\n- Red\n- Green\n- Blue/);
  const open = (await client.call("session.events.since", { session_id: session, last_seen: 0 })).open_requests;
  assert.deepEqual(open, []);
});

test("a message the person sends answers a question asked without waiting: its card goes, and its row says answered", async () => {
  await withAsyncClient(async (client) => {
    const session = await createThread(client);
    await client.call("prompt.submit", { session_id: session, text: "meanwhile please", profile: "fake" });
    const request = await client.nextRequest();
    await client.nextEvent("message.complete", session);
    await client.call("prompt.submit", { session_id: session, text: "blue, thanks", profile: "fake" });
    const cancel = await client.nextEvent("request.cancel", session);
    assert.deepEqual(cancel.payload, { id: request.id, reason: "replied" });
    await client.nextEvent("message.complete", session);
    const messages = (await client.call("session.resume", { session_id: session })).messages;
    const row = messages.find((message: Frame) => message.name === "clarify");
    assert.equal(row.content, "null");
    assert.ok(messages.some((message: Frame) => message.role === "user" && message.text === "blue, thanks"));
  });
});

test("Stop takes back a question asked without waiting, and its row says it went unanswered", async () => {
  await withAsyncClient(async (client) => {
    const session = await createThread(client);
    await client.call("prompt.submit", { session_id: session, text: "meanwhile please", profile: "fake" });
    const first = await client.nextRequest();
    await client.nextEvent("message.complete", session);
    assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
    const cancel = await client.nextEvent("request.cancel", session);
    assert.deepEqual(cancel.payload, { id: first.id, reason: "interrupted" });
    const messages = (await client.call("session.resume", { session_id: session })).messages;
    assert.deepEqual(JSON.parse(messages.find((message: Frame) => message.name === "clarify").content), { responses: [], unanswered: true });
  });
});

test("after a restart of the bridge, a card's answer reads back as its row's, its message the card's; questions left open are their card again", async (t) => {
  const asks = { capabilities: { async_questions: true, subagent_requests: true } };
  const first = await startTestBridge({ keepHome: true });
  const home = first.home;
  // Whatever fails, nothing is left open.
  const open: { close(): Promise<void> }[] = [first];
  t.after(async () => {
    for (const thing of open.reverse()) await thing.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  });
  const shut = async (thing: { close(): Promise<void> }) => {
    open.splice(open.indexOf(thing), 1);
    await thing.close();
  };
  {
    let phone = await TestClient.open(first, asks);
    open.push(phone);
    // One answered on its card, one left open.
    const answered = await createThread(phone);
    await phone.call("prompt.submit", { session_id: answered, text: "meanwhile please", profile: "fake" });
    const asked = await phone.nextRequest();
    await phone.nextEvent("message.complete", answered);
    phone.answer(asked.id, { answers: { q0: "Green" } });
    const start = await phone.nextEvent("message.start", answered);
    assert.equal(start.payload.text, "Green");
    const row = (messages: Frame[]) => messages.find((message) => message.name === "clarify");
    assert.equal(start.payload.card_answer, row((await phone.call("session.resume", { session_id: answered })).messages).tool_call_id);
    await phone.nextEvent("message.complete", answered);
    const left = await createThread(phone);
    await phone.call("prompt.submit", { session_id: left, text: "meanwhile please", profile: "fake" });
    await phone.nextRequest();
    await phone.nextEvent("message.complete", left);
    await shut(phone);
    await shut(first);

    const second = await startTestBridge({ home, keepHome: true });
    open.push(second);
    {
      // An older app reads them as before: no card, the row unanswered.
      const older = await TestClient.open(second);
      open.push(older);
      const before = await older.call("session.resume", { session_id: left });
      assert.deepEqual(before.open_requests, []);
      assert.deepEqual(JSON.parse(row(before.messages).content), { responses: [], unanswered: true });
      await shut(older);

      phone = await TestClient.open(second, asks);
      open.push(phone);
      const back = (await phone.call("session.resume", { session_id: answered })).messages as Frame[];
      assert.deepEqual(JSON.parse(row(back).content), { responses: [{ question: "Which colour should the README heading use?", user_response: "Green" }] });
      const said = back.find((message) => message.role === "user" && message.text === "Green");
      assert.equal(said.card_answer, row(back).tool_call_id);
      assert.equal(back.find((message) => message.role === "user" && message.text === "meanwhile please").card_answer, undefined);

      const again = await phone.call("session.resume", { session_id: left });
      assert.equal(again.open_requests.length, 1);
      assert.equal(again.open_requests[0].params.async, true);
      assert.deepEqual(JSON.parse(row(again.messages).content), { responses: [], asking: true });
      assert.equal((await phone.call("sessions.activity")).sessions.find((entry: Frame) => entry.session_id === left)?.state, "waiting");
      phone.answer(again.open_requests[0].id, { answers: { q0: "Blue" } });
      const reopened = await phone.nextEvent("message.start", left);
      assert.equal(reopened.payload.text, "Blue");
      assert.equal(reopened.payload.card_answer, row(again.messages).tool_call_id);
      await phone.nextEvent("message.complete", left);
      const after = (await phone.call("session.resume", { session_id: left })).messages as Frame[];
      assert.deepEqual(JSON.parse(row(after).content), { responses: [{ question: "Which colour should the README heading use?", user_response: "Blue" }] });
    }
  }
});

test("liveoutput: a command printing fifty lines a second goes out as at most four live updates a second, the newest whole each time", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "liveoutput brief");
  const progress = ofType(events, "tool.progress");
  // Three seconds of output: about 150 lines in 12 or so updates, not 150.
  assert.ok(progress.length >= 6 && progress.length <= 16, `${progress.length} updates`);
  assert.ok(progress.at(-1)!.payload.output.split("\n").length > 100);
  assert.equal(ofType(events, "tool.complete").length, 1);
});

test("bgcommand: a command left running is a command row after the turn ends, with its output, and Stop ends it", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "bgcommand brief");
  const [started] = ofType(events, "subagent.start");
  assert.equal(started.payload.kind, "command");
  assert.equal(started.payload.can_stop, true);
  assert.equal(started.payload.summary, "listening on http://localhost:5173");
  const progress = await client.nextEvent("subagent.progress", session);
  assert.match(progress.payload.output, /GET \/page\/\d+ 200/);
  await client.call("subagent.stop", { session_id: session, subagent_id: started.payload.subagent_id });
  const done = await client.nextEvent("subagent.complete", session);
  assert.equal(done.payload.status, "stopped");
});

test("crew: a command, a subagent with its own, a workflow and a finished subagent; the thread is at work until only the command runs", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, "crew brief");
  const started = ofType(events, "subagent.start").map((event) => event.payload);
  assert.deepEqual(started.map((subagent) => subagent.kind), ["command", "agent", "agent", "workflow", "agent"]);
  const [, explore, inner, review] = started;
  assert.equal(inner.parent_id, explore.subagent_id);
  assert.deepEqual(review.phases.map((phase: Frame) => phase.title), ["Draft", "Review"]);
  assert.equal(review.agents.length, 3);
  // Its agents can be read, what each was asked first; not the command or the workflow.
  assert.deepEqual(started.map((subagent) => subagent.can_read === true), [false, true, true, false, true]);
  const read = await client.call("subagent.read", { session_id: session, subagent_id: explore.subagent_id });
  assert.deepEqual(read.messages.map((message: Frame) => message.role), ["user", "tool", "assistant"]);
  assert.equal(read.messages[0].text, explore.goal);
  assert.deepEqual(await client.call("subagent.read", { session_id: session, subagent_id: review.subagent_id }), { available: false });
  // At work while the crew works, after the turn.
  const atWork = async () => (await client.call("sessions.activity")).sessions.some((entry: Frame) => entry.session_id === session);
  assert.equal(await atWork(), true);
  // Stop on one of the crew ends it, stopped; the others end by themselves.
  await client.call("subagent.stop", { session_id: session, subagent_id: explore.subagent_id });
  let listed = (await client.call("subagent.list", { session_id: session })).subagents as Frame[];
  assert.equal(listed.find((subagent) => subagent.subagent_id === explore.subagent_id)?.status, "stopped");
  assert.equal(listed.find((subagent) => subagent.kind === "command")?.status, "running");
  for (let waited = 0; waited < 100; waited += 1) {
    listed = (await client.call("subagent.list", { session_id: session })).subagents as Frame[];
    if (listed.every((subagent) => subagent.kind === "command" || subagent.status !== "running")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The command alone runs on: the thread is no longer at work.
  assert.deepEqual(listed.filter((subagent) => subagent.status === "running").map((subagent) => subagent.kind), ["command"]);
  assert.equal(await atWork(), false);
});

test("crew: a session closed with its crew at work says nothing more of it", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "portals-fake-crew-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const events: ProviderEvent[] = [];
  const sink: SessionSink = { emit: (event) => void events.push(event), ask: () => new Promise(() => undefined) };
  const session = await new FakeProvider({ directory, delayMs: 1 }).startSession(
    { id: "crew-closed", cwd: directory, settings: { model: "fake-1", provider: "fake", reasoningEffort: "" } } as SessionOptions,
    sink,
  );
  session.startTurn({ text: "crew brief", images: [] } as Prompt);
  for (let waited = 0; waited < 200 && !events.some((event) => event.type === "turn.end"); waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(events.some((event) => event.type === "turn.end"));
  // The quick one ends at once; the others would end after three seconds.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await session.close();
  const closed = events.length;
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.equal(events.length, closed);
});

test("the fake agent goes by the message's own words, not by the line saying who sent it", async () => {
  const session = await createThread(client);
  const events = await runTurn(client, session, '[Portals: from Fake agent · "visual tall crew" (thread 4439)]\nhello');
  assert.match(streamedText(events), /^Hello from the fake agent\./);
  assert.equal(ofType(events, "subagent.start").length, 0);
});
