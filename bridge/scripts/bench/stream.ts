import { Device, Pinger } from "./device.ts";
import { pick } from "./lines.ts";
import { recipe } from "./registry.ts";
import { bridgeWith, inside, longest, measured, median, percentile, round, table, type Cell, type Measured, type Run, type Table } from "./run.ts";
import type { BenchBridge } from "./scratch.ts";

// `stream`: one thread streaming a long reply, a word an event, to M connections that
// follow it. Each event is made into text once for every follower, so the cost of a
// word grows with the followers.

export interface StreamPass {
  followers: number;
  measured: Measured;
  /** Events each follower received, and their bytes. */
  events: number;
  bytes: number;
  pings: number[];
}

/** A bridge with a thread whose first turn is done, followed by the device that made it. */
export async function readyToStream(run: Run, name: string, counters: boolean): Promise<{ bridge: BenchBridge; owner: Device; thread: string }> {
  const { bridge } = await bridgeWith(run, name, { threads: run.quick ? 10 : 100 }, { counters });
  try {
    const owner = await Device.open(bridge);
    const thread = (await owner.call("session.create", { profile: "fake", source: "tui" })).session_id as string;
    // A first, short turn: the title it gives is then not among the streamed events.
    await aTurn(owner, thread, recipe.prompt);
    return { bridge, owner, thread };
  } catch (error) {
    await bridge.stop();
    throw error;
  }
}

async function aTurn(owner: Device, thread: string, text: string): Promise<void> {
  const ended = owner.event("message.complete", thread);
  await owner.call("prompt.submit", { session_id: thread, text, profile: "fake" });
  await ended;
}

/** `turns` long replies streamed to `followers` connections, the owner's among them, while another device pings. */
export async function measureStream(run: Run, bridge: BenchBridge, owner: Device, thread: string, followers: number, turns: number): Promise<StreamPass> {
  const others: Device[] = [];
  for (let index = 1; index < followers; index += 1) {
    const device = await Device.open(bridge);
    await device.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
    others.push(device);
  }
  const pinging = await Pinger.start(bridge);
  const mark = owner.totals();
  let pings: number[] = [];
  const [result] = await measured(run, [bridge], async () => {
    pinging.times.length = 0;
    for (let index = 0; index < turns; index += 1) await aTurn(owner, thread, recipe.slowPrompt);
    pings = await pinging.stop();
  });
  const received = owner.since(mark).events;
  await Promise.all(others.map((device) => device.disconnect()));
  return { followers, measured: result, events: received.n, bytes: received.bytes, pings };
}

export async function stream(run: Run): Promise<Table[]> {
  const turns = run.quick ? 1 : 3;
  const counts = run.quick ? [2] : [1, 5, 20];
  run.say(`stream: ${turns} long ${turns === 1 ? "reply" : "replies"} to ${counts.join(", ")} followers`);
  const ready = await readyToStream(run, "stream", run.counters);
  const rows: Cell[][] = [];
  try {
    for (const followers of counts) {
      const pass = await measureStream(run, ready.bridge, ready.owner, ready.thread, followers, turns);
      const counted = pass.measured.counted;
      const seconds = pass.measured.wallMs / 1000;
      const emitted = pick(counted, "emit", "n");
      rows.push([
        followers,
        round(pass.events / seconds),
        round(pass.bytes / pass.events),
        inside(counted, pick(counted, "out", "events", "n") / seconds),
        inside(counted, pick(counted, "out", "events", "bytes") / seconds / 1024),
        inside(counted, (pick(counted, "emit", "ms") / Math.max(emitted, 1)) * 1000),
        inside(counted, pick(counted, "emit", "max")),
        inside(counted, pick(counted, "out", "events", "buffered_max")),
        round((pass.measured.cpuMs / pass.events) * 1000),
        round(median(pass.pings)),
        round(percentile(pass.pings, 0.99)),
        round(longest(pass.pings)),
      ]);
    }
    await ready.owner.disconnect();
  } finally {
    await ready.bridge.stop();
  }
  return [
    table(
      "stream",
      `a long reply streamed to M followers, ${turns} ${turns === 1 ? "turn" : "turns"} each`,
      [
        "Followers",
        "Events a second to each",
        "Bytes an event",
        "Frames a second to all",
        "KB a second to all",
        "µs to hand an event to its followers",
        "Longest ms",
        "Most bytes waiting in a socket",
        "Bridge CPU µs an event",
        "Ping ms: median",
        "99th",
        "longest",
      ],
      rows,
      [
        `The scripted agent's long reply is about 75 words, ${recipe.delayMs * 8} ms apart, so events a second is its speed; what grows with the followers is the bridge's time and bytes for each.`,
        "The ping times are another device's gateway.ping, sent every 5 ms meanwhile. Frames and bytes to all, the time to hand an event over and the bytes waiting are from the bridge's own lines, so they show only with the counters on.",
      ],
    ),
  ];
}
