import "./environment.ts";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setLogLevel } from "../src/log.ts";
import { JsonChild, type ChildExit } from "../src/providers/child.ts";

// The bridge's end of an agent run as a child process that speaks one JSON value per
// line, against a stand-in program (test/child-standin.ts): where a line ends, what is
// told of the process's end, and that a stop leaves nothing of it running.

setLogLevel("silent");

const standin = fileURLToPath(new URL("./child-standin.ts", import.meta.url));
const started: JsonChild[] = [];
/** What a stand-in started, to end whatever a failed test left of it. */
const strays: number[] = [];

after(async () => {
  await Promise.all(started.map((child) => child.stop()));
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already, as it should be.
    }
  }
});

interface Run {
  child: JsonChild;
  messages: any[];
  notJSON: string[];
  exits: ChildExit[];
  /** What came after its end was told; nothing should. */
  late: unknown[];
}

function run(command = process.execPath, args = [standin]): Run {
  const messages: any[] = [];
  const notJSON: string[] = [];
  const exits: ChildExit[] = [];
  const late: unknown[] = [];
  const child = new JsonChild({
    name: "Stand-in",
    command,
    args,
    env: process.env,
    cwd: tmpdir(),
    listener: {
      message: (value) => (exits.length === 0 ? messages : late).push(value),
      notJSON: (line) => (exits.length === 0 ? notJSON : late).push(line),
      exited: (exit) => exits.push(exit),
    },
  });
  started.push(child);
  return { child, messages, notJSON, exits, late };
}

async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}

/** Asks the stand-in to start a process of its own; that one's id. */
async function spawned({ child, messages }: Run, how: { deaf?: boolean; inherit?: boolean } = {}): Promise<number> {
  child.send({ do: "spawn", ...how });
  await until(() => messages.length === 1);
  strays.push(messages[0].spawned);
  return messages[0].spawned;
}

test("values go both ways one to a line, and a line ends at LF and nowhere else", async () => {
  const { child, messages, notJSON } = run();
  // The separators readline also cuts at, as they are, inside a string.
  const text = "one two three";
  assert.equal(JSON.stringify(text).length, text.length + 2);
  assert.equal(child.send({ do: "echo", value: text }), true);
  await until(() => messages.length === 1);
  assert.deepEqual(messages, [{ echo: text }]);

  // A line that arrives in two pieces, cut inside a character; two lines in one piece;
  // a CR before the LF; an empty line.
  const bytes = Buffer.from('{"text":"héllo 🙂"}\n{"n":1}\r\n\n{"n":2}\n');
  const cut = bytes.indexOf(Buffer.from("🙂")) + 2;
  child.send({ do: "write", parts: [bytes.subarray(0, cut).toString("base64"), bytes.subarray(cut).toString("base64")] });
  await until(() => messages.length === 4);
  assert.deepEqual(messages.slice(1), [{ text: "héllo 🙂" }, { n: 1 }, { n: 2 }]);

  // A line that is not JSON is told as it is, and the next one is read.
  child.send({ do: "write", parts: [base64('Update available: 1.2.3\r\n{"n":3}\n')] });
  await until(() => messages.length === 5);
  assert.deepEqual(notJSON, ["Update available: 1.2.3"]);
  assert.deepEqual(messages[4], { n: 3 });
});

test("its end is told once, after its last line, with its exit code and its last words", async () => {
  const { child, messages, exits, late } = run();
  assert.equal(child.running, true);
  child.send({ do: "echo", value: "up" });
  await until(() => messages.length === 1);
  child.send({ do: "write", to: "stderr", parts: [base64("warming up\n\nit broke\n")] });
  // Some lines, and a last one with no LF.
  child.send({ do: "echo", value: "x".repeat(40), times: 200 });
  child.send({ do: "write", parts: [base64('{"last":true}')] });
  child.send({ do: "exit", code: 3 });
  // Nothing is read for a while, so that the process is gone before its lines are.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  await until(() => exits.length === 1);
  assert.equal(messages.length, 202);
  assert.deepEqual(messages.at(-1), { last: true });
  assert.deepEqual(exits[0], { code: 3, signal: null, error: null, asked: false, lastWords: "it broke", reason: "Stand-in stopped (exit code 3): it broke" });
  assert.equal(child.running, false);
  assert.equal(child.send({ do: "echo", value: "anyone?" }), false);
  // Nothing is left to stop, and nothing more is told.
  await child.stop();
  assert.equal(exits.length, 1);
  assert.deepEqual(late, []);
});

test("a program that is not there is told as one that could not be started", async () => {
  const { child, exits } = run("/nonexistent/agent", []);
  assert.equal(child.pid, undefined);
  assert.equal(child.running, false);
  assert.equal(child.send({ do: "echo", value: "anyone?" }), false);
  await child.stop();
  assert.equal(exits.length, 1);
  assert.deepEqual([exits[0].code, exits[0].signal, exits[0].asked], [null, null, false]);
  assert.match(exits[0].error ?? "", /ENOENT/);
  assert.equal(exits[0].reason, `Stand-in could not be started (${exits[0].error})`);

  // So is one Node refuses to try: told afterwards, not thrown at the caller.
  const refused = run(process.execPath, ["\0"]);
  assert.equal(refused.exits.length, 0);
  await refused.child.stop();
  assert.equal(refused.exits.length, 1);
  assert.equal(refused.exits[0].reason, `Stand-in could not be started (${refused.exits[0].error})`);
});

test("a stop ends the process and what it started", async () => {
  const running = run();
  const { child, exits } = running;
  const started = await spawned(running);
  const pid = child.pid!;
  const stopped = child.stop();
  assert.equal(child.running, false);
  assert.equal(child.send({ do: "echo", value: "anyone?" }), false);
  // Asked twice, it is the one stop.
  assert.equal(child.stop(), stopped);
  await stopped;
  assert.deepEqual(exits, [{ code: null, signal: "SIGTERM", error: null, asked: true, lastWords: exits[0].lastWords, reason: "Stand-in stopped (SIGTERM)" }]);
  assert.equal(alive(pid), false);
  // What it started has no parent left to collect it at once.
  await until(() => !alive(started));
});

test("a process that ignores SIGTERM is killed two seconds later", async () => {
  const { child, messages, exits } = run();
  child.send({ do: "deaf" });
  await until(() => messages.length === 1);
  const pid = child.pid!;
  const began = Date.now();
  await child.stop();
  assert.ok(Date.now() - began >= 1900);
  assert.equal(exits[0].signal, "SIGKILL");
  assert.equal(alive(pid), false);
});

test("what the process started is killed too when it ignores SIGTERM, though the process went at once", async () => {
  const running = run();
  const started = await spawned(running, { deaf: true });
  const began = Date.now();
  await running.child.stop();
  // The process itself went by SIGTERM; the stop waited for the rest of its group.
  assert.equal(running.exits[0].signal, "SIGTERM");
  assert.ok(Date.now() - began >= 1900);
  await until(() => !alive(started));
});

test("a process that ends by itself takes what it started with it", async () => {
  const running = run();
  const { child, exits } = running;
  const started = await spawned(running);
  child.send({ do: "exit", code: 3 });
  // With no stop asked for.
  await until(() => !alive(started));
  await until(() => exits.length === 1);
  assert.deepEqual([exits[0].code, exits[0].signal, exits[0].asked], [3, null, false]);
  await child.stop();
  assert.equal(exits.length, 1);
});

test("the end of a process is told even while something it started holds its output open, and that is killed two seconds later when it ignores SIGTERM", async () => {
  const running = run();
  const { child, exits } = running;
  const started = await spawned(running, { deaf: true, inherit: true });
  const began = Date.now();
  child.send({ do: "exit", code: 0 });
  await until(() => exits.length === 1);
  assert.deepEqual([exits[0].code, exits[0].signal, exits[0].asked], [0, null, false]);
  // Told while what it started was still there, holding the output.
  assert.equal(alive(started), true);
  // A stop asked for afterwards has nothing left to signal, and waits for the rest of the group to be gone.
  await child.stop();
  assert.ok(Date.now() - began >= 1900);
  await until(() => !alive(started));
});

test("what it writes to standard error goes to the debug log, a line at a time and cut short", async (t) => {
  const written = t.mock.method(process.stderr, "write", () => true);
  const logged = () => written.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes("Stand-in standard error"));
  setLogLevel("debug");
  try {
    const { child } = run();
    child.send({ do: "write", to: "stderr", parts: [base64(`first line\nsecond ${"x".repeat(2000)}\n`)] });
    await until(() => logged().some((line) => line.includes("second")));
    await child.stop();
  } finally {
    setLogLevel("silent");
  }
  const lines = logged().map((line) => JSON.parse(line.slice(line.indexOf("{"))).line as string);
  assert.equal(lines.includes("first line"), true);
  assert.equal(lines.find((line) => line.startsWith("second"))?.length, 500);
});

test("half of a surrogate pair goes to the program as U+FFFD, which a JSON reader that refuses the half (Codex's) takes", async () => {
  const { child, messages } = run();
  assert.equal(child.send({ do: "echo", value: "Fix \u{1F680}".slice(0, -1) }), true);
  await until(() => messages.length === 1);
  assert.deepEqual(messages, [{ echo: "Fix �" }]);
});
