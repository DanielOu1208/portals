import { randomBytes } from "node:crypto";
import { Device, Pinger } from "./device.ts";
import { pick } from "./lines.ts";
import { recipe } from "./registry.ts";
import { bridgeWith, calls, inside, longest, measured, median, percentile, round, table, type Cell, type Measured, type Run, type Table } from "./run.ts";
import type { BenchBridge } from "./scratch.ts";

// `turns`: turns in a thread, in a list of 100, 1000 and 5000 threads. A turn's start
// and its end each rewrite threads.json whole, so what a turn costs grows with the
// list, and so does what every device then fetches.
//
// One device sends the turns and looks at the thread, as a person does: it fetches the
// list when the turn ends and answers with a seen, which is one more write and one
// more revision for the other devices. A second device only polls. A device registered
// for notifications watches the thread, so the bridge reads push.json at each turn's
// end as an installed one does.

/**
 * One turn, with what each device does around it. Turns in real use last longer than a
 * poll's five seconds, so every device polls once while the turn runs and once after it;
 * here those two polls are made at once instead of waited for.
 */
export async function turn(sender: Device, others: Device[], thread: string, text: string): Promise<void> {
  const started = sender.event("message.start", thread);
  const ended = sender.event("message.complete", thread);
  await sender.call("prompt.submit", { session_id: thread, text, profile: "fake" });
  await started;
  // The turn's start moved the list.
  await Promise.all([sender, ...others].map((device) => device.poll()));
  await ended;
  // The thread looked at: the list at once, and the merge finds it unseen (HostModel's onTurnFinished).
  await sender.fetch();
  await sender.seen(thread);
  // The turn's end and the seen moved it again.
  await Promise.all([sender, ...others].map((device) => device.poll()));
}

/** A thread made by `sender` with its first turn done, which gave it its title, and both devices holding the list. */
export async function threadWithATurn(sender: Device, others: Device[]): Promise<string> {
  await Promise.all([sender, ...others].map((device) => device.poll()));
  const thread = (await sender.call("session.create", { profile: "fake", source: "tui" })).session_id as string;
  await turn(sender, others, thread, recipe.prompt);
  return thread;
}

/** What a device registers for notifications with: its token, the relay's token for it and its key. */
export interface PushIdentity {
  token: string;
  relay_token: string;
  key: string;
}

export function pushIdentity(): PushIdentity {
  return { token: randomBytes(32).toString("hex"), relay_token: randomBytes(48).toString("base64url"), key: randomBytes(32).toString("base64") };
}

/** Registers a device for notifications about `threads`, as the app does each time it connects. */
export async function watchForPush(device: Device, identity: PushIdentity, threads: { id: string; title: string }[]): Promise<void> {
  const response = await device.http("push", "PUT", "/api/plugins/aeriportal-push/registration", {
    device: { ...identity, environment: "sandbox", bundle_id: "com.example.portals.bench" },
    threads: threads.map((thread) => ({ id: thread.id, agent: "fake", agent_name: "Fake agent", title: thread.title })),
    host: "bench-host",
  });
  if (response.status !== 200) throw new Error(`the push registration answered ${response.status}: ${response.text}`);
}

export interface TurnsPass {
  turns: number;
  measured: Measured;
  /** What the device that only polls fetched. */
  watcherFetches: { n: number; down: number };
  /** Each ping's time, when a third device pinged meanwhile. */
  pings: number[];
}

/** `turns` turns in one thread of `bridge`, measured: with `pinger`, while a third device pings every 5 ms. */
export async function measureTurns(run: Run, bridge: BenchBridge, sender: Device, watcher: Device, thread: string, turns: number, pinger: boolean): Promise<TurnsPass> {
  const pinging = pinger ? await Pinger.start(bridge) : null;
  const mark = watcher.totals();
  let pings: number[] = [];
  const [result] = await measured(run, [bridge], async () => {
    // From here on: the pings made while waiting for the opening edge are not the turns'.
    if (pinging) pinging.times.length = 0;
    for (let index = 0; index < turns; index += 1) await turn(sender, [watcher], thread, recipe.prompt);
    // Stopped before the closing edge, so the lines hold its pings too and nothing else.
    if (pinging) pings = await pinging.stop();
  });
  const fetched = calls(watcher.since(mark), "threads.changes");
  return { turns, measured: result, watcherFetches: { n: fetched.n, down: fetched.down }, pings };
}

/** A bridge with `size` threads, two devices and a thread of theirs ready for turns. */
export async function readyForTurns(run: Run, name: string, size: number, counters: boolean): Promise<{ bridge: BenchBridge; bytes: number; bytesPerRecord: number; sender: Device; watcher: Device; thread: string }> {
  const { bridge, written } = await bridgeWith(run, name, { threads: size }, { counters });
  try {
    const sender = await Device.open(bridge);
    const watcher = await Device.open(bridge);
    const thread = await threadWithATurn(sender, [watcher]);
    await watchForPush(sender, pushIdentity(), [{ id: thread, title: "The thread the turns run in" }]);
    return { bridge, bytes: written.bytes, bytesPerRecord: written.bytesPerRecord, sender, watcher, thread };
  } catch (error) {
    await bridge.stop();
    throw error;
  }
}

export async function turns(run: Run): Promise<Table[]> {
  const count = run.quick ? 4 : 50;
  const rows: Cell[][] = [];
  for (const size of run.sizes) {
    run.say(`turns: ${count} turns twice in a list of ${size} threads`);
    const ready = await readyForTurns(run, `turns-${size}`, size, run.counters);
    try {
      const alone = await measureTurns(run, ready.bridge, ready.sender, ready.watcher, ready.thread, count, false);
      const pinged = await measureTurns(run, ready.bridge, ready.sender, ready.watcher, ready.thread, count, true);
      const counted = alone.measured.counted;
      const per = (value: number) => value / count;
      rows.push([
        size,
        round(ready.bytes / 1024),
        ready.bytesPerRecord,
        inside(counted, per(pick(counted, "files", "threads", "w"))),
        inside(counted, per(pick(counted, "files", "threads", "w_bytes")) / 1024),
        inside(counted, per(pick(counted, "files", "threads", "w_ms"))),
        inside(counted, pick(counted, "files", "threads", "w_max")),
        inside(counted, per(pick(counted, "files", "push", "r"))),
        round(per(alone.watcherFetches.n)),
        round(per(alone.watcherFetches.down)),
        round(per(alone.measured.cpuMs)),
        round(count / (alone.measured.wallMs / 1000)),
        round(median(pinged.pings)),
        round(percentile(pinged.pings, 0.99)),
        round(longest(pinged.pings)),
      ]);
      await Promise.all([ready.sender.disconnect(), ready.watcher.disconnect()]);
    } finally {
      await ready.bridge.stop();
    }
  }
  return [
    table(
      "turns",
      `${count} turns in one thread, in a list of N threads`,
      [
        "Threads",
        "threads.json KB",
        "Bytes a record",
        "threads.json writes a turn",
        "KB written a turn",
        "ms in writes a turn",
        "Longest write ms",
        "push.json reads a turn",
        "Other device: threads.changes a turn",
        "Other device: bytes fetched a turn",
        "Bridge CPU ms a turn",
        "Turns a second",
        "Ping ms: median",
        "99th",
        "longest",
      ],
      rows,
      [
        "The sending device looks at the thread: at each turn's end it fetches the list and sends its seen, which is one of the writes. Every device polls once while a turn runs and once after it.",
        "The other device only polls, and fetches what the turn changed. A device registered for notifications watches the thread.",
        `The scripted agent answers in about twenty words, ${recipe.delayMs} ms apart, so turns a second is its speed more than the bridge's. CPU and turns a second are from a pass with nothing else connected; the ping times are a second pass's, with a third device sending gateway.ping every 5 ms: a long ping is the bridge held up.`,
        "Writes, bytes written and reads are from the bridge's own lines, so they show only with the counters on, and then the counters' ticks during the pass (one a second) are in the CPU. The longest write is how long the bridge did nothing else.",
      ],
    ),
  ];
}
