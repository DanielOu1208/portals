import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { counters } from "../../src/counters.ts";
import { idleOptions, measureIdle } from "./idle.ts";
import { round, table, type Cell, type Run, type Table } from "./run.ts";
import { measureStream, readyToStream } from "./stream.ts";
import { measureTurns, readyForTurns } from "./turns.ts";

// `cost`: what the counters themselves cost, three ways. A loop over each counting
// function gives nanoseconds a call. An idle bridge with them off and one with them on,
// side by side at the real tick of a minute, give CPU a minute. And turns and a stream
// with them off and on give what a busy bridge loses to them. On an installed bridge
// `tick_ms` in every line says the rest: what a tick took there. All of that is the
// bridge's own process; the `ps` a tick starts is another, whose CPU time no number
// here holds (`kids.ps_ms` is how long its answer took to come, a busy bridge's wait
// for it included).

/** Nanoseconds a call of `work`, over `times` calls. */
function nanoseconds(work: () => void, times: number): number {
  // Once through first, so what is timed is the compiled code.
  for (let index = 0; index < Math.min(times, 10_000); index += 1) work();
  const started = performance.now();
  for (let index = 0; index < times; index += 1) work();
  return ((performance.now() - started) * 1e6) / times;
}

/** Each counting function called in a loop in this process, with the counters on in a folder of the scratch root. */
function countingCalls(run: Run): Cell[][] {
  const times = run.quick ? 20_000 : 1_000_000;
  const folder = run.scratch.folder("counting");
  const config = join(folder, "config.json");
  writeFileSync(config, JSON.stringify({ counters: { enabled: true } }));
  const threads = join(folder, "state", "threads.json");
  const agent = new (class FakeProvider {})();
  const text = "x".repeat(200);
  let kept = 0;
  const empty = nanoseconds(() => {
    kept += 1;
  }, times);
  // As at a place that counts: `if (counters.on) counters.…(…)`.
  const places: [string, () => void][] = [
    ["A frame sent (sent)", () => { if (counters.on) counters.sent("events", 180, 0); }],
    ["A call answered (rpc)", () => { if (counters.on) counters.rpc("sessions.activity", "app", 0.2, 60, 120, false, false); }],
    ["An event given out (emitted)", () => { if (counters.on) counters.emitted(0.05); }],
    ["A file written (wrote)", () => { if (counters.on) counters.wrote(threads, 500_000, 1.5); }],
    ["A file read (read)", () => { if (counters.on) counters.read(threads, 500_000, 1.5); }],
    ["A turn started (turn)", () => { if (counters.on) counters.turn("started"); }],
    ["A threads.changes answer (changes)", () => { if (counters.on) counters.changes("delta", 1); }],
    ["An HTTP request (http)", () => { if (counters.on) counters.http("ticket", 0.3, 2, 60); }],
    ["A call to a linked Mac (linked)", () => { if (counters.on) counters.linked(0, 12, 300, 4000, 0, false, false); }],
    ["A session loaded (loaded)", () => { if (counters.on) counters.loaded(agent, 3); }],
    ["Two reads of the clock, as around a timed step", () => { const started = performance.now(); kept += performance.now() - started; }],
    ["The byte length of a 200-character text", () => { kept += Buffer.byteLength(text); }],
  ];
  const rows: Cell[][] = [];
  const off = nanoseconds(places[0][1], times);
  rows.push(["Any of them with the counters off: the branch", round(Math.max(off - empty, 0))]);
  // A tick an hour away: the loop is over before one.
  if (!counters.start({ config, file: join(folder, "counters.log"), seconds: 3600 })) throw new Error("the counters did not start in the harness's own process");
  try {
    for (const [name, work] of places) rows.push([name, round(Math.max(nanoseconds(work, times) - empty, 0))]);
  } finally {
    counters.stop();
  }
  return rows;
}

export async function cost(run: Run): Promise<Table[]> {
  run.say("cost: each counting function in a loop");
  const counting = countingCalls(run);

  // Side by side, so both see the same Mac at the same moment; a bridge's CPU time is its own.
  const rounds = run.quick ? 1 : 3;
  const idleRows: Cell[][] = [];
  const differences: number[] = [];
  for (let pass = 1; pass <= rounds; pass += 1) {
    run.say(`cost: an idle bridge with the counters off and one with them on, round ${pass} of ${rounds}`);
    const [off, on] = await Promise.all([measureIdle(run, idleOptions(run, false, `cost-idle-off-${pass}`)), measureIdle(run, idleOptions(run, true, `cost-idle-on-${pass}`))]);
    differences.push(on.cpuMs - off.cpuMs);
    idleRows.push([`Idle, round ${pass}: bridge CPU ms a minute`, round(off.cpuMs), round(on.cpuMs), round(on.cpuMs - off.cpuMs), `${on.ticks} ${on.ticks === 1 ? "tick" : "ticks"} while watched`]);
    idleRows.push([`Idle, round ${pass}: bridge memory MB`, round(off.rss), round(on.rss), round(on.rss - off.rss), ""]);
  }
  const spread = differences.length > 1 ? `between ${round(Math.min(...differences))} and ${round(Math.max(...differences))} ms a minute over the rounds` : "one round";

  // Off and on side by side here too.
  const both = <Value>(work: (counted: boolean, name: string) => Promise<Value>) => Promise.all([work(false, "off"), work(true, "on")]);
  const busy: Cell[][] = [];
  const pair = (what: string, off: number, on: number) => busy.push([what, round(off), round(on), round(on - off), ""]);

  const size = run.quick ? run.sizes[0] : 1000;
  const turnCount = run.quick ? 4 : 50;
  run.say(`cost: ${turnCount} turns in ${size} threads with the counters off and on`);
  const turned = await both(async (counted, name) => {
    const ready = await readyForTurns(run, `cost-turns-${name}`, size, counted);
    try {
      const pass = await measureTurns(run, ready.bridge, ready.sender, ready.watcher, ready.thread, turnCount, false);
      await Promise.all([ready.sender.disconnect(), ready.watcher.disconnect()]);
      return { cpu: pass.measured.cpuMs / turnCount, rate: turnCount / (pass.measured.wallMs / 1000) };
    } finally {
      await ready.bridge.stop();
    }
  });
  pair(`Turns in ${size} threads: bridge CPU ms a turn`, turned[0].cpu, turned[1].cpu);
  pair(`Turns in ${size} threads: turns a second`, turned[0].rate, turned[1].rate);

  const followers = run.quick ? 2 : 5;
  const streamTurns = run.quick ? 1 : 3;
  run.say(`cost: a stream to ${followers} followers with the counters off and on`);
  const streamed = await both(async (counted, name) => {
    const ready = await readyToStream(run, `cost-stream-${name}`, counted);
    try {
      const pass = await measureStream(run, ready.bridge, ready.owner, ready.thread, followers, streamTurns);
      await ready.owner.disconnect();
      return { cpu: (pass.measured.cpuMs / Math.max(pass.events, 1)) * 1000, rate: pass.events / (pass.measured.wallMs / 1000) };
    } finally {
      await ready.bridge.stop();
    }
  });
  pair(`A stream to ${followers} followers: bridge CPU µs an event`, streamed[0].cpu, streamed[1].cpu);
  pair(`A stream to ${followers} followers: events a second`, streamed[0].rate, streamed[1].rate);

  const idleNote = run.quick
    ? `Idle: both bridges at once, with a tick every ${run.tick} s (the short run).`
    : "Idle: both bridges at once, three devices at rest on each, the counters at their real tick of a minute. The difference was " + spread + ".";
  return [
    table("cost", "what one counting call takes, in this process", ["Counted", "Nanoseconds a call"], counting, [
      "The harness's own loop is taken off. With the counters off a place that counts is one read and a branch.",
      "A place that times something also reads the clock twice, and one that weighs a text takes its byte length: the last two rows.",
    ]),
    table("cost", "a bridge with the counters off and with them on", ["Measured", "Off", "On", "On less off", ""], [...idleRows, ...busy], [
      idleNote,
      "Bridge CPU is the bridge's own process. The `ps` the counters start at each tick is a process of its own and is in none of these numbers. Its CPU time is not measured; `kids.ps_ms` in a bridge's lines says how long each one's answer took to come, which on a busy bridge is longer than the `ps` ran.",
      `Turns and the stream: one pass each, the two bridges at once, the one with the counters on at a tick every ${run.tick} s, where an installed bridge has one a minute: the ticks that fell in the pass are in its numbers. They are the smaller part: at a tick of a minute the turns cost as much more.`,
    ]),
  ];
}
