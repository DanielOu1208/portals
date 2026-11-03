import { setTimeout as sleep } from "node:timers/promises";
import { Device } from "./device.ts";
import { pick } from "./lines.ts";
import { bridgeWith, calls, inside, measured, median, round, table, type Run, type Table } from "./run.ts";

// `loads`: every thread of a list read once through the fleet (`thread.read`, what the
// `portals` command uses). A read loads the thread's session, and a loaded
// session stays loaded for as long as the bridge runs: what each costs in time, and
// what the bridge's memory is before, after, and a while later.

export async function loads(run: Run): Promise<Table[]> {
  const threads = run.quick ? 30 : 1000;
  const messages = run.quick ? 6 : 40;
  const waitSeconds = run.quick ? 0.5 : 15;
  run.say(`loads: reading ${threads} threads of ${messages} messages each`);
  const { bridge, written } = await bridgeWith(run, "loads", { threads, messages });
  try {
    const device = await Device.open(bridge);
    const mark = device.totals();
    const [result] = await measured(run, [bridge], async () => {
      for (const id of written.ids) await device.call("thread.read", { thread: id });
    });
    const read = calls(device.since(mark), "thread.read");
    await sleep(waitSeconds * 1000);
    const later = await bridge.sample();
    await device.disconnect();
    const counted = result.counted;
    const kilobytesEach = (from: number, to: number) => round(((to - from) * 1024) / threads);
    return [
      table(
        "loads",
        `${threads} threads of ${messages} messages each, read once through thread.read`,
        [
          "Threads read",
          "ms a read (median)",
          "ms a load",
          "Longest load ms",
          "Answer bytes",
          "Sessions loaded after",
          "Memory MB before",
          "after",
          `${waitSeconds} s later`,
          "Heap MB before",
          "after",
          `${waitSeconds} s later`,
          "Memory KB a session",
          "Heap KB a session",
        ],
        [
          [
            threads,
            round(median(read.ms)),
            inside(counted, pick(counted, "load", "fake", "ms") / Math.max(pick(counted, "load", "fake", "n"), 1)),
            inside(counted, pick(counted, "load", "fake", "max")),
            round(read.down / threads),
            inside(counted, counted?.now.loaded ?? 0),
            round(result.before.rss),
            round(result.after.rss),
            round(later.rss),
            round(result.before.heap),
            round(result.after.heap),
            round(later.heap),
            kilobytesEach(result.before.rss, later.rss),
            kilobytesEach(result.before.heap, later.heap),
          ],
        ],
        [
          "Memory is the bridge process's resident memory, heap its JavaScript heap in use; per session is what was gained from before to the later reading, over the threads read.",
          "A scripted thread is small, so the real figure for a session comes from the installed bridges (proc.rss over now.loaded in their lines). What this shows is that nothing is given back.",
          "The time of a load and the count of loaded sessions are from the bridge's own lines, so they show only with the counters on.",
        ],
      ),
    ];
  } finally {
    await bridge.stop();
  }
}
