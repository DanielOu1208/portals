import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { asShown, LiveOutput, outputTail } from "../src/providers/liveOutput.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

function live(intervalMs = 40) {
  const events: ProviderEvent[] = [];
  const output = new LiveOutput((event) => events.push(event), { intervalMs });
  return { events, output };
}

test("the first piece of a call's output goes out at once, the rest at most once an interval, the newest whole", async () => {
  const { events, output } = live();
  output.append("call-1", "line 1\n");
  assert.deepEqual(events, [{ type: "tool.progress", id: "call-1", output: "line 1\n", outputTruncated: false }]);
  for (let line = 2; line <= 50; line += 1) output.append("call-1", `line ${line}\n`);
  assert.equal(events.length, 1, "fifty lines at once are one update, not fifty");
  await sleep(80);
  assert.equal(events.length, 2);
  const last = events[1] as Extract<ProviderEvent, { type: "tool.progress" }>;
  assert.ok(last.output!.startsWith("line 1\n") && last.output!.endsWith("line 50\n"));
});

test("a call that ends lets go of an update waiting, and sends nothing after", async () => {
  const { events, output } = live();
  output.append("a", "one\n");
  output.append("a", "two\n");
  output.end("a");
  await sleep(80);
  assert.equal(events.length, 1);
  output.clear();
});

test("only the end of a long output is kept and said to be cut", () => {
  const { events, output } = live();
  output.append("a", "x".repeat(100_000));
  const first = events[0] as Extract<ProviderEvent, { type: "tool.progress" }>;
  assert.equal(first.output!.length, 8192);
  assert.equal(first.outputTruncated, true);
  assert.equal(output.tail("a")!.output.length, 8192);
  output.clear();
});

test("a whole output in place of the last one sends nothing when it is the same", () => {
  const { events, output } = live(0);
  output.replace("a", "line 1\n");
  output.replace("a", "line 1\n");
  output.replace("a", "line 1\nline 2\n");
  assert.equal(events.length, 2);
  assert.equal((events[1] as { output?: string }).output, "line 1\nline 2\n");
});

test("a status line goes out on its own, with the output kept", () => {
  const { events, output } = live(0);
  output.status("a", "Running for 5 s");
  assert.deepEqual(events, [{ type: "tool.progress", id: "a", progress: "Running for 5 s" }]);
});

test("output is shown as a terminal shows it: a redrawn progress bar keeps its last state", () => {
  assert.equal(asShown("tick 1\r\ntick 2\r\n"), "tick 1\ntick 2\n");
  assert.equal(asShown("10%\r50%\r100%\ndone\n"), "100%\ndone\n");
  assert.equal(asShown("waiting\r"), "waiting");
  assert.equal(asShown("plain\n"), "plain\n");
});

test("the tail keeps whole UTF-8 characters and at most 200 lines", () => {
  const lines = Array.from({ length: 300 }, (_, index) => `${index}`).join("\n");
  const tail = outputTail(lines);
  assert.equal(tail.output.split("\n").length, 200);
  assert.equal(tail.truncated, true);
  const wide = outputTail("é".repeat(5000));
  assert.ok(!wide.output.includes("�"));
});
