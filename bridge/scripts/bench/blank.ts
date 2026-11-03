import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Device } from "./device.ts";

// The bridge's half of scripts/blank-bench.sh (a thread opened blank until scrolled by
// hand): threads like the ones the user saw it with, long, with visuals, some of them
// streaming the fake agent's minute-long reply while they are opened. The shell script
// starts and stops the bridge (with scroll.ts config) and streams (scroll.ts stream).
//
//   node scripts/bench/blank.ts seed <url> <user> <password> <ids.json>
//       makes the threads below and writes their ids by name to <ids.json>.
//   node scripts/bench/blank.ts add <url> <user> <password> <ids.json> <name>
//       makes one more, and adds it to <ids.json>.
//   node scripts/bench/blank.ts titles <url> <user> <password> <ids.json>
//       names the threads of <ids.json> again (below).
//
// The threads, by name (and title, which the UI test finds the rows by; named again once
// their turns are in, as the fake agent names a thread after its first visual's prompt):
//   long60, long45   that many turns of the long reply (fakeBench.ts)
//   vis45            45 turns, a visual every few (fakeVisuals.ts), ending on three
//   stream45         45 turns of the long reply, to stream into
//   streamvis        40 turns with visuals, to stream into
//   shortlast        45 turns of the long reply, then a one-line one (not seeded by default)
//   vislast          45 turns of the long reply, then one with a visual (nor this one)
//   short1…short4    one short turn each

const [command, url, username, password, out, name] = process.argv.slice(2);

interface Shape {
  title: string;
  /** The prompt of each turn, from the first. */
  prompts: () => string[];
  /** Made by `seed`; the others only by `add`. */
  seeded: boolean;
}

const bench = (count: number) => Array.from({ length: count }, (_, index) => `bench instant, turn ${index + 1}`);

/** The prompt of turn `index` (from 0) of `count` in a thread with visuals. */
function visualPrompt(index: number, count: number): string {
  const fromEnd = count - index;
  if (fromEnd === 3) return `visual tall, turn ${index + 1}`;
  if (fromEnd === 2) return `visual many, turn ${index + 1}`;
  if (fromEnd === 1) return `visual, turn ${index + 1}`;
  if (index % 7 === 3) return `visual many, turn ${index + 1}`;
  if (index % 4 === 1) return `visual, turn ${index + 1}`;
  return `bench instant, turn ${index + 1}`;
}
const visuals = (count: number) => Array.from({ length: count }, (_, index) => visualPrompt(index, count));

const shapes: Record<string, Shape> = {
  short1: { title: "Short 1", prompts: () => ["hello 1"], seeded: true },
  short2: { title: "Short 2", prompts: () => ["hello 2"], seeded: true },
  short3: { title: "Short 3", prompts: () => ["hello 3"], seeded: true },
  short4: { title: "Short 4", prompts: () => ["hello 4"], seeded: true },
  long60: { title: "Long 60", prompts: () => bench(60), seeded: true },
  long45: { title: "Long 45", prompts: () => bench(45), seeded: true },
  vis45: { title: "Visuals 45", prompts: () => visuals(45), seeded: true },
  stream45: { title: "Streaming 45", prompts: () => bench(45), seeded: true },
  streamvis: { title: "Streaming visuals", prompts: () => visuals(40), seeded: true },
  shortlast: { title: "Short last", prompts: () => [...bench(45), "hello, turn 46"], seeded: false },
  vislast: { title: "Visual last", prompts: () => [...bench(45), "visual, turn 46"], seeded: false },
};

async function turn(device: Device, thread: string, text: string): Promise<void> {
  const ended = device.event("message.complete", thread);
  await device.call("prompt.submit", { session_id: thread, text, profile: "fake" });
  await ended;
}

async function rename(device: Device, ids: Record<string, string>): Promise<void> {
  for (const [key, thread] of Object.entries(ids)) {
    if (shapes[key]) await device.call("session.rename", { session_id: thread, title: shapes[key].title, profile: "fake" });
  }
}

async function make(device: Device, key: string): Promise<string> {
  const shape = shapes[key];
  if (!shape) throw new Error(`no thread shape ${key}`);
  const started = performance.now();
  const thread = (await device.call("session.create", { profile: "fake", source: "tui" })).session_id as string;
  const prompts = shape.prompts();
  for (const prompt of prompts) await turn(device, thread, prompt);
  await device.call("session.rename", { session_id: thread, title: shape.title, profile: "fake" });
  console.error(`${key}: ${prompts.length} turns in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  return thread;
}

async function main(): Promise<void> {
  if (!["seed", "add", "titles"].includes(command)) throw new Error("usage: blank.ts seed|add|titles <url> <user> <password> <ids.json> [name]");
  const device = await Device.open({ url, account: { username, password } });
  try {
    if (command === "titles") {
      await rename(device, JSON.parse(readFileSync(out, "utf8")) as Record<string, string>);
      return;
    }
    if (command === "add") {
      const ids = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
      ids[name] = await make(device, name);
      writeFileSync(out, JSON.stringify(ids, null, 1));
      return;
    }
    const ids: Record<string, string> = {};
    for (const [key, shape] of Object.entries(shapes)) {
      if (shape.seeded) ids[key] = await make(device, key);
    }
    writeFileSync(out, JSON.stringify(ids, null, 1));
  } finally {
    await device.disconnect();
  }
}

await main();
process.exit(0);
