import { Device } from "./device.ts";
import { pick } from "./lines.ts";
import { all, bridgeWith, calls, inside, measured, median, round, table, type Cell, type Run, type Table } from "./run.ts";

// `marks`: a pin, an archive, a rename and a remove, each made on one device while a
// second one watches. What one change to the list costs the bridge (which files, how
// many times) and both devices (the change, then the list fetched again).

interface Operation {
  name: string;
  /** The call's method, for its bytes and time. */
  method: string;
  make(device: Device, thread: string, index: number): Promise<unknown>;
}

const operations: Operation[] = [
  { name: "pin", method: "thread.mark", make: (device, thread) => device.call("thread.mark", { thread, pinned: true }) },
  { name: "archive", method: "thread.mark", make: (device, thread) => device.call("thread.mark", { thread, archived: true }) },
  { name: "rename", method: "session.rename", make: (device, thread, index) => device.call("session.rename", { session_id: thread, title: `A title given by the harness, number ${index + 1}`, profile: "fake" }) },
  { name: "remove", method: "thread.delete", make: (device, thread) => device.call("thread.delete", { thread }) },
];

export async function marks(run: Run): Promise<Table[]> {
  const size = run.quick ? 40 : 1000;
  const each = run.quick ? 3 : 20;
  run.say(`marks: ${each} of each change in a list of ${size} threads`);
  // Ten threads apart, so the marked ones of the written list (pinned or archived already) are not among them.
  const { bridge, written } = await bridgeWith(run, "marks", { threads: Math.max(size, operations.length * each * 10) });
  const rows: Cell[][] = [];
  try {
    const maker = await Device.open(bridge);
    const watcher = await Device.open(bridge);
    await Promise.all([maker.poll(), watcher.poll()]);
    for (const [place, operation] of operations.entries()) {
      const threads = Array.from({ length: each }, (_, index) => written.ids[(place * each + index) * 10]);
      const marksBefore = [maker.totals(), watcher.totals()];
      const [result] = await measured(run, [bridge], async () => {
        for (const [index, thread] of threads.entries()) {
          await operation.make(maker, thread, index);
          // A change made here is followed by the list it moved; the other device finds it at its next poll.
          await maker.fetch();
          await watcher.poll();
        }
      });
      const made = maker.since(marksBefore[0]);
      const watched = watcher.since(marksBefore[1]);
      const change = calls(made, operation.method);
      const per = (value: number) => value / each;
      const counted = result.counted;
      rows.push([
        operation.name,
        inside(counted, per(pick(counted, "files", "threads", "w"))),
        inside(counted, per(pick(counted, "files", "removed", "w"))),
        inside(counted, per(pick(counted, "files", "threads", "w_bytes") + pick(counted, "files", "removed", "w_bytes")) / 1024),
        inside(counted, per(pick(counted, "load", "fake", "n"))),
        round(per(change.up)),
        round(per(change.down)),
        round(median(change.ms)),
        round(per(calls(made, "threads.changes").down)),
        round(per(all(watched).n)),
        round(per(calls(watched, "threads.changes").down)),
      ]);
    }
    await Promise.all([maker.disconnect(), watcher.disconnect()]);
  } finally {
    await bridge.stop();
  }
  return [
    table(
      "marks",
      `one change to a list of ${written.ids.length} threads, ${each} times each`,
      [
        "Change",
        "threads.json writes",
        "removed.json writes",
        "KB written",
        "Sessions loaded",
        "Request bytes",
        "Answer bytes",
        "Call ms (median)",
        "This device: bytes fetched after",
        "Other device: calls",
        "Other device: bytes fetched",
      ],
      rows,
      [
        "Per change. The device that makes it fetches the list again at once (threads.changes since the revision it held); the other device polls once and fetches what changed.",
        "A rename goes through session.rename, which loads the thread's session to tell the agent, and the session stays loaded.",
        "Writes, bytes written and sessions loaded are from the bridge's own lines, so they show only with the counters on.",
      ],
    ),
  ];
}
