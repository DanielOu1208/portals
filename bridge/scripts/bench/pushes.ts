import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { Device, type Totals } from "./device.ts";
import { Link } from "./link.ts";
import { shapesFor } from "./network.ts";
import { recipe } from "./registry.ts";
import { bridgeWith, calls, median, round, table, type Cell, type Run, type Table } from "./run.ts";

// `pushes`: what a turn costs a device other than the one that sends it, when it only
// polls (`sessions.activity` every five seconds while its sidebar is out, as before) and
// when the bridge tells it to poll (feature poll_now: `poll.now` a moment after something
// moved, then the device polls a second later, as the app does), its sidebar hidden or
// out; and how long after a turn's end its list shows it. Turns here last a few seconds
// and come ten seconds apart, so a device that only polls polls twice a turn, as `turns`
// counts it, and the turn's start and end are each told.
//
// Then how long the wait after `poll.now` must be for the device looking at the thread to
// have sent its seen first, so the other devices never show the thread unseen: that
// device behind the poor link of `network`, three others on this Mac, each waiting a
// different time.

interface Pace {
  turns: number;
  /** From one turn's start to the next one's. */
  cycleMs: number;
  /** The scripted agent's pause between words: about seventeen words a turn. */
  delayMs: number;
  /** The app's wait after `poll.now` (HostSync.listMoveWait). */
  waitMs: number;
  /** The waits tried behind the poor link. */
  waits: number[];
  threads: number;
  pollMs: number;
}

function paceFor(run: Run): Pace {
  return run.quick
    ? { turns: 2, cycleMs: 1500, delayMs: 5, waitMs: 100, waits: [300, 100, 30], threads: 50, pollMs: 500 }
    : { turns: 6, cycleMs: 10_000, delayMs: 150, waitMs: 1000, waits: [1000, 500, 250], threads: 1000, pollMs: 5000 };
}

/** The list's calls a device made, and the `poll.now` events it heard. */
interface ListCost {
  activity: number;
  changes: number;
  marks: number;
  told: number;
  up: number;
  down: number;
}

function listCost(totals: Totals, toldBytes: number, told: number): ListCost {
  const activity = calls(totals, "sessions.activity");
  const changes = calls(totals, "threads.changes");
  const marks = calls(totals, "thread.mark");
  return {
    activity: activity.n,
    changes: changes.n,
    marks: marks.n,
    told,
    up: activity.up + changes.up + marks.up,
    down: activity.down + changes.down + marks.down + toldBytes,
  };
}

/** A device's place in the measuring: its totals and what it had heard when it began. */
class Watched {
  readonly device: Device;
  readonly name: string;
  /** For each turn, how long after the sender heard its end this device's list showed it; null when it did not before the next turn. */
  readonly shownAfter: (number | null)[] = [];
  shownUnseen = 0;
  private mark: Totals;
  private toldBefore: number;
  private toldBytesBefore: number;

  constructor(name: string, device: Device) {
    this.name = name;
    this.device = device;
    this.mark = device.totals();
    this.toldBefore = device.told;
    this.toldBytesBefore = device.toldBytes;
  }

  begin(): void {
    this.mark = this.device.totals();
    this.toldBefore = this.device.told;
    this.toldBytesBefore = this.device.toldBytes;
  }

  cost(): ListCost {
    return listCost(this.device.since(this.mark), this.device.toldBytes - this.toldBytesBefore, this.device.told - this.toldBefore);
  }
}

/**
 * One turn in `thread`, sent by `sender`, which looks at the thread: at its end it fetches
 * the list and sends its seen (HostModel's onTurnFinished). Notes, for each of `others`,
 * when its list showed the end, and whether it ever showed the thread unseen. Returns
 * how long the sender took from hearing the end to the seen's answer.
 */
async function cycle(sender: Device, others: Watched[], thread: string, pace: Pace): Promise<number> {
  const started = performance.now();
  const ended = sender.event("message.complete", thread);
  await sender.call("prompt.submit", { session_id: thread, text: recipe.prompt, profile: "fake" });
  await ended;
  const endedAt = performance.now();
  await sender.fetch();
  const end = sender.threads.get(thread)?.revision ?? 0;
  await sender.seen(thread);
  const seenAfter = performance.now() - endedAt;
  const until = started + pace.cycleMs;
  await sleep(Math.max(0, until - performance.now()));
  for (const watched of others) {
    // When a fetch first brought the turn's end, by the clock of this Mac, which every device here shares.
    const first = (watched.device.merged.get(thread) ?? []).find((entry) => entry.revision >= end && entry.at >= started);
    watched.shownAfter.push(first ? first.at - endedAt : null);
    if ((watched.device.shownUnseen.get(thread) ?? 0) >= end) watched.shownUnseen += 1;
  }
  return seenAfter;
}

/** Every device holding the list, the thread made with its first turn done, and the pushing devices quiet. */
async function ready(sender: Device, devices: Device[]): Promise<string> {
  await Promise.all([sender, ...devices].map((device) => device.poll()));
  const thread = (await sender.call("session.create", { profile: "fake", source: "tui" })).session_id as string;
  const ended = sender.event("message.complete", thread);
  await sender.call("prompt.submit", { session_id: thread, text: recipe.prompt, profile: "fake" });
  await ended;
  await sender.fetch();
  await sender.seen(thread);
  await sleep(1500);
  await Promise.all([sender, ...devices].map((device) => device.quiet()));
  return thread;
}

const shown = (values: (number | null)[]): Cell => {
  const reached = values.filter((value): value is number => value !== null);
  return reached.length === values.length ? round(median(reached)) : `${round(median(reached))} (${values.length - reached.length} not before the next turn)`;
};

async function onThisMac(run: Run, pace: Pace): Promise<Table> {
  const { bridge } = await bridgeWith(run, "pushes", { threads: pace.threads }, { delayMs: pace.delayMs });
  const pushes = { waitMs: pace.waitMs };
  const devices: Device[] = [];
  try {
    const sender = await Device.open(bridge, { pushes });
    const pollOnly = await Device.open(bridge);
    const hidden = await Device.open(bridge, { pushes });
    const out = await Device.open(bridge, { pushes });
    devices.push(sender, pollOnly, hidden, out);
    const thread = await ready(sender, [pollOnly, hidden, out]);
    pollOnly.startPolling(pace.pollMs, 15_000);
    out.startPolling(pace.pollMs, 15_000);
    const watched = [
      new Watched("Polls every 5 s (sidebar out), not told", pollOnly),
      new Watched("Told to poll, sidebar hidden (no 5 s poll)", hidden),
      new Watched("Told to poll, and polls every 5 s (sidebar out)", out),
    ];
    const looking = new Watched("The device looking at the thread (sends the turns, fetches at each end and sends its seen), told to poll, sidebar hidden", sender);
    for (const each of [...watched, looking]) each.begin();
    for (let index = 0; index < pace.turns; index += 1) await cycle(sender, watched, thread, pace);
    await Promise.all(devices.map((device) => device.quiet()));
    const rows: Cell[][] = [...watched, looking].map((each) => {
      const cost = each.cost();
      const per = (value: number) => round(value / pace.turns);
      return [
        each.name,
        per(cost.activity),
        per(cost.changes),
        per(cost.marks),
        per(cost.told),
        per(cost.up),
        per(cost.down),
        each === looking ? null : shown(each.shownAfter),
        each === looking ? null : each.shownUnseen,
      ];
    });
    return table(
      "pushes",
      `What a turn costs each device on this Mac, ${pace.turns} turns ${pace.cycleMs / 1000} s apart in a list of ${pace.threads} threads`,
      ["Device", "sessions.activity a turn", "threads.changes a turn", "thread.mark a turn", "poll.now a turn", "Bytes up a turn", "Bytes down a turn", "List shows a turn's end after, median ms", "Turns shown unseen"],
      rows,
      [
        `Each turn is the scripted agent's reply of about seventeen words, ${pace.delayMs} ms apart; the next starts ${pace.cycleMs / 1000} s after it started. The device looking at the thread fetches the list as the turn ends and sends its seen (HostModel's onTurnFinished); those two calls are in its row. It takes the list from the seen's answer, as the app does from a bridge that offers poll_now (HostSync.sendSeen), so the poll its seen brings fetches nothing.`,
        `A device told to poll asks for poll.now in client.capabilities and polls ${pace.waitMs} ms after one (HostSync.listMoveWait), once for every one heard meanwhile; the bridge sends it 200 ms after the first move of a burst. A device that polls every ${pace.pollMs / 1000} s skips a poll while one is on its way.`,
        "Bytes are of sessions.activity, threads.changes and thread.mark, both ways, and of the poll.now events: the list's cost, not the turn's events, which only the looking device follows. List shows a turn's end: from the looking device hearing message.complete to the other device's fetch that brought the revision of the turn's end.",
      ],
    );
  } finally {
    await Promise.all(devices.map((device) => device.disconnect()));
    await bridge.stop();
  }
}

async function theWait(run: Run, pace: Pace): Promise<Table> {
  const { bridge } = await bridgeWith(run, "pushes-wait", { threads: pace.threads }, { delayMs: pace.delayMs });
  const link = await Link.open(bridge.url, shapesFor(run.quick).poor);
  const devices: Device[] = [];
  try {
    const sender = await Device.open({ url: link.url, account: bridge.account }, { pushes: { waitMs: pace.waitMs } });
    devices.push(sender);
    const others: Watched[] = [];
    for (const waitMs of pace.waits) {
      const device = await Device.open(bridge, { pushes: { waitMs } });
      devices.push(device);
      others.push(new Watched(String(waitMs), device));
    }
    const thread = await ready(sender, others.map((each) => each.device));
    for (const each of others) each.begin();
    const seen: number[] = [];
    for (let index = 0; index < pace.turns; index += 1) seen.push(await cycle(sender, others, thread, pace));
    await Promise.all(devices.map((device) => device.quiet()));
    const rows: Cell[][] = others.map((each) => {
      const cost = each.cost();
      return [Number(each.name), `${each.shownUnseen} of ${pace.turns}`, round(cost.activity / pace.turns), round(cost.changes / pace.turns), round(cost.told / pace.turns), shown(each.shownAfter)];
    });
    return table(
      "pushes",
      "How long a device told to poll must wait for the device looking at the thread to send its seen first, that device behind the poor link",
      ["Wait after poll.now, ms", "Turns shown unseen", "sessions.activity a turn", "threads.changes a turn", "poll.now a turn", "List shows a turn's end after, median ms"],
      rows,
      [
        `The device looking at the thread is behind ${run.quick ? "a short stand-in for the poor link" : "the poor link of network (150 ms each way, 2 Mbit/s down and 1 up, 1% of segments lost)"}: from hearing message.complete to its seen's answer took ${round(median(seen))} ms (median of ${pace.turns}). The three devices told to poll are on this Mac, each waiting the time in its row after a poll.now, sidebar hidden.`,
        "A device that polls before the seen reaches the bridge fetches the thread unseen and shows it so until the seen's poll.now has it poll again: one turn shown unseen, and one fetch more. List shows a turn's end: from the looking device hearing message.complete, which reaches it a crossing of the link after the bridge sent it, to the other device's fetch that brought the turn's end.",
      ],
    );
  } finally {
    await Promise.all(devices.map((device) => device.disconnect()));
    await link.close();
    await bridge.stop();
  }
}

export async function pushes(run: Run): Promise<Table[]> {
  const pace = paceFor(run);
  run.say(`pushes: ${pace.turns} turns ${pace.cycleMs / 1000} s apart, devices that poll and devices told to poll`);
  const costs = await onThisMac(run, pace);
  run.say(`pushes: the same, the device looking at the thread behind the poor link, others waiting ${pace.waits.join(", ")} ms`);
  const wait = await theWait(run, pace);
  return [costs, wait];
}
