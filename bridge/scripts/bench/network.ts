import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { afterConnecting } from "./connect.ts";
import { Device, type CatchUp } from "./device.ts";
import { Link, type Shape } from "./link.ts";
import { pick } from "./lines.ts";
import { recipe } from "./registry.ts";
import { all, bridgeWith, inside, measured, median, round, table, type Cell, type Measured, type Run, type Table } from "./run.ts";
import type { BenchBridge } from "./scratch.ts";
import { pushIdentity } from "./turns.ts";

// `network`: a device that reaches the bridge over a bad network (link.ts) where every
// other scenario's devices are on this Mac's loopback. What a connect costs on it, how
// long a turn's end takes to reach it, what the bridge holds for it while it stops
// reading, and how long it takes to catch up after its connection is cut.
//
// Two links: a poor mobile one, and Wi-Fi, which is fast but where the phone stops
// reading as soon as the system suspends the app. The device that sends the turns of a
// stall and a cut is on loopback, and follows the same threads: what it was sent is
// what the device on the link was sent, and how far it got is where the other has to
// catch up to.

export function shapesFor(quick: boolean): { poor: Shape; wifi: Shape } {
  if (quick) {
    return {
      poor: { latencyMs: 10, down: 1_000_000, up: 500_000, loss: 0.01, handshakes: 2, window: 64 * 1024 },
      wifi: { latencyMs: 1, down: 50_000_000, up: 50_000_000, loss: 0, handshakes: 2, window: 256 * 1024 },
    };
  }
  return {
    // 150 ms each way, 2 Mbit/s down and 1 up, one segment in a hundred lost.
    poor: { latencyMs: 150, down: 250_000, up: 125_000, loss: 0.01, handshakes: 2, window: 256 * 1024 },
    // 5 ms each way and 100 Mbit/s; the phone's own buffer takes a megabyte before it stops taking more.
    wifi: { latencyMs: 5, down: 12_500_000, up: 12_500_000, loss: 0, handshakes: 2, window: 1024 * 1024 },
  };
}

/** How long a device keeps trying to catch up before the harness gives up. */
const patienceMs = 120_000;

/** Turns of each reply whose end is timed; the middle one is shown. */
function turnsEach(run: Run): number {
  return run.quick ? 1 : 3;
}

/** How far into the minute-long reply a cut comes, in milliseconds. */
function cutAfterMs(run: Run): number {
  return run.quick ? 100 : 2000;
}

/** How often the bridge's memory is read during a stall, in milliseconds. */
function memoryEveryMs(run: Run): number {
  return run.quick ? 50 : 250;
}

async function aTurn(device: Device, thread: string, text: string): Promise<void> {
  const ended = device.event("message.complete", thread);
  await device.call("prompt.submit", { session_id: thread, text, profile: "fake" });
  await ended;
}

/** The biggest number of bytes waiting in a socket right after a frame was handed to it, of every kind of frame. */
function mostWaiting(measured: Measured): Cell {
  const counted = measured.counted;
  return inside(counted, Math.max(...["ready", "answers", "events", "asks"].map((kind) => pick(counted, "out", kind, "buffered_max"))));
}

// MARK: Connecting

async function connectOver(run: Run, size: number, shape: Shape): Promise<Cell[][]> {
  const registered = run.quick ? 5 : 50;
  const { bridge, written } = await bridgeWith(run, `network-${size}`, { threads: size });
  const link = await Link.open(bridge.url, shape);
  const rows: Cell[][] = [];
  try {
    const other = await Device.open(bridge);
    const thread = (await other.call("session.create", { profile: "fake", source: "tui" })).session_id as string;
    await aTurn(other, thread, recipe.prompt);
    const watched = written.ids.slice(0, registered).map((id) => ({ id, title: "A thread this device started, with a title of usual length" }));
    const phone = new Device({ url: link.url, account: bridge.account });
    const identity = pushIdentity();

    const measure = async (name: string, connecting: () => Promise<void>) => {
      const mark = phone.totals();
      const crossed = link.totals();
      const [result] = await measured(run, [bridge], connecting);
      const counted = phone.since(mark);
      const sum = all(counted);
      const now = link.totals();
      const slowest = [...counted.calls].map(([method, stats]) => ({ method, ms: Math.max(...stats.ms) })).sort((a, b) => b.ms - a.ms)[0];
      rows.push([size, name, sum.n, sum.up, sum.down, now.up - crossed.up, now.down - crossed.down, round(result.wallMs), `${slowest.method} ${round(slowest.ms)} ms`, round(result.cpuMs)]);
    };
    await measure("first", async () => {
      await phone.signIn();
      await phone.connect();
      await afterConnecting(phone, thread, identity, watched, false);
    });
    // As in `connect`: a turn while it follows the thread, then one while it is away.
    await aTurn(other, thread, recipe.prompt);
    await phone.disconnect();
    await aTurn(other, thread, recipe.prompt);
    await measure("again", async () => {
      await phone.connect();
      await afterConnecting(phone, thread, identity, watched, true);
    });
    await Promise.all([phone.disconnect(), other.disconnect()]);
  } finally {
    await link.close();
    await bridge.stop();
  }
  return rows;
}

// MARK: A turn's end

async function turnEnds(run: Run, bridge: BenchBridge, owner: Device, thread: string, name: string, shape: Shape): Promise<Cell[][]> {
  const link = await Link.open(bridge.url, shape);
  const rows: Cell[][] = [];
  try {
    const phone = await Device.open({ url: link.url, account: bridge.account });
    await phone.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
    // The long reply takes most of a second: the short run leaves it out.
    const replies = [["a short reply", recipe.prompt], ...(run.quick ? [] : [["a long reply, streamed", recipe.slowPrompt]])];
    for (const [reply, text] of replies) {
      const atOwner: number[] = [];
      const atPhone: number[] = [];
      const mark = phone.totals();
      const crossed = link.totals();
      const count = turnsEach(run);
      for (let index = 0; index < count; index += 1) {
        const started = performance.now();
        const seen = (device: Device) => device.event("message.complete", thread).then(() => performance.now() - started);
        const [owned, phoned] = [seen(owner), seen(phone)];
        await phone.call("prompt.submit", { session_id: thread, text, profile: "fake" });
        atOwner.push(await owned);
        atPhone.push(await phoned);
      }
      const events = phone.since(mark).events;
      rows.push([name, reply, round(events.n / count), round((link.totals().down - crossed.down) / count), round(median(atOwner)), round(median(atPhone)), round(median(atPhone.map((ms, index) => ms - atOwner[index])))]);
    }
    await phone.disconnect();
  } finally {
    await link.close();
  }
  return rows;
}

// MARK: A stall

/**
 * Waits until `phone` holds every event `owner` held at the start (as the app holds a
 * thread's), connecting again and catching up the way the app does if the connection
 * went meanwhile.
 */
async function caughtUp(phone: Device, owner: Device, threads: string[]): Promise<void> {
  const target = new Map(threads.map((thread) => [thread, owner.lastSeq.get(thread) ?? 0]));
  const ends = performance.now() + patienceMs;
  for (;;) {
    if ([...target].every(([thread, seq]) => (phone.lastSeq.get(thread) ?? 0) >= seq)) return;
    if (performance.now() > ends) throw new Error(`the device did not catch up in ${patienceMs / 1000} s`);
    if (!phone.connected) {
      await phone.connect();
      await Promise.all(threads.map((thread) => phone.catchUp(thread)));
      continue;
    }
    await sleep(2);
  }
}

/** The bridge's resident memory, read every `everyMs` until `until` settles; the most it was. */
async function mostMemory(bridge: BenchBridge, until: Promise<unknown>, everyMs: number): Promise<number> {
  let done = false;
  void until.finally(() => (done = true)).catch(() => undefined);
  let most = 0;
  while (!done) {
    most = Math.max(most, (await bridge.sample()).rss);
    await sleep(everyMs);
  }
  return most;
}

/**
 * The device on `shape` follows `threads` and stops reading for `seconds` while
 * `streaming` sends to them, then reads again and catches up. What the bridge did is
 * measured over the stall alone: catching up asks for more, which a device that reads
 * is sent at once.
 */
async function stallOver(
  run: Run,
  bridge: BenchBridge,
  owner: Device,
  threads: string[],
  shape: Shape,
  seconds: number,
  streaming: (until: number) => Promise<void>,
): Promise<{ measured: Measured; stalledSeconds: number; sentKB: number; mostRSS: number; afterRSS: number; closed: boolean; catchUpMs: number }> {
  const link = await Link.open(bridge.url, shape);
  try {
    const phone = await Device.open({ url: link.url, account: bridge.account });
    for (const thread of threads) await phone.resume(thread);
    const mark = owner.totals();
    const drops = phone.drops;
    let mostRSS = 0;
    let stalledAt = 0;
    const [result] = await measured(run, [bridge], async () => {
      link.stall();
      stalledAt = performance.now();
      const stalled = streaming(stalledAt + seconds * 1000);
      mostRSS = await mostMemory(bridge, stalled, memoryEveryMs(run));
      await stalled;
    });
    // The wait for the counters' line is part of the stall: the device reads again only now.
    const resumed = performance.now();
    const sentKB = owner.since(mark).events.bytes / 1024;
    link.resume();
    await caughtUp(phone, owner, threads);
    const catchUpMs = performance.now() - resumed;
    const after = await bridge.sample();
    const closed = phone.drops > drops;
    await phone.disconnect();
    return { measured: result, stalledSeconds: (resumed - stalledAt) / 1000, sentKB, mostRSS, afterRSS: after.rss, closed, catchUpMs };
  } finally {
    await link.close();
  }
}

// MARK: A cut

/** How a device catches up after a cut: as the app did before `resume_replay`, and as it does with it. */
const cutCatchUps: [CatchUp, string][] = [
  ["since", "session.resume, then session.events.since"],
  ["replay", "session.resume from the last event held"],
];

async function cutOver(run: Run, bridge: BenchBridge, owner: Device, thread: string, name: string, shape: Shape, how: CatchUp): Promise<Cell[]> {
  const link = await Link.open(bridge.url, shape);
  try {
    const phone = await Device.open({ url: link.url, account: bridge.account });
    await phone.resume(thread);
    // The minute-long reply, cut a little way in.
    const ended = owner.event("message.complete", thread);
    await owner.call("prompt.submit", { session_id: thread, text: "bench", profile: "fake" });
    await sleep(cutAfterMs(run));
    const mark = phone.totals();
    const drops = phone.drops;
    link.cut();
    const cut = performance.now();
    while (phone.drops === drops) {
      if (performance.now() - cut > patienceMs) throw new Error("the device did not notice its connection was cut");
      await sleep(1);
    }
    const crossed = link.totals();
    await phone.connect();
    const connected = performance.now() - cut;
    const missed = await phone.catchUp(thread, how);
    const caught = performance.now() - cut;
    const sum = all(phone.since(mark));
    const now = link.totals();
    await owner.call("session.interrupt", { session_id: thread });
    await ended;
    await phone.disconnect();
    const shown = cutCatchUps.find(([way]) => way === how)?.[1] ?? how;
    return [name, shown, missed ?? "all (truncated)", round(connected), round(caught), sum.n, now.up - crossed.up, now.down - crossed.down];
  } finally {
    await link.close();
  }
}

export async function network(run: Run): Promise<Table[]> {
  const shapes = shapesFor(run.quick);
  const connectRows: Cell[][] = [];
  for (const size of run.sizes) {
    run.say(`network: a first connect and a later one over the poor link, with ${size} threads`);
    connectRows.push(...(await connectOver(run, size, shapes.poor)));
  }

  const stallSeconds = run.quick ? 0.25 : 10;
  // Heavy enough to pass the bridge's bound on what waits for a device (8 MB) within the
  // stall also when the device takes it compressed.
  const floodThreads = run.quick ? 3 : 100;
  const floodGapMs = run.quick ? 5 : 10;
  const endRows: Cell[][] = [];
  const stallRows: Cell[][] = [];
  const cutRows: Cell[][] = [];
  const { bridge } = await bridgeWith(run, "network", { threads: run.quick ? 10 : 100 });
  try {
    const owner = await Device.open(bridge);
    const thread = (await owner.call("session.create", { profile: "fake", source: "tui" })).session_id as string;
    await aTurn(owner, thread, recipe.prompt);

    run.say("network: a turn's end over each link");
    endRows.push(...(await turnEnds(run, bridge, owner, thread, "poor", shapes.poor)));
    endRows.push(...(await turnEnds(run, bridge, owner, thread, "Wi-Fi", shapes.wifi)));

    run.say(`network: a device that stops reading for ${stallSeconds} s while a reply streams, and while a flood does`);
    const stallRow = (what: string, name: string, stall: Awaited<ReturnType<typeof stallOver>>): Cell[] => [
      what,
      name,
      round(stall.stalledSeconds),
      round(stall.sentKB),
      mostWaiting(stall.measured),
      round(stall.measured.before.rss),
      round(stall.mostRSS),
      round(stall.afterRSS),
      stall.closed ? "yes" : "no",
      round(stall.catchUpMs),
      round(stall.measured.cpuMs),
    ];
    // The minute-long reply streams through the stall, and is stopped once the device caught up.
    const ended = owner.event("message.complete", thread);
    await owner.call("prompt.submit", { session_id: thread, text: "bench", profile: "fake" });
    await sleep(run.quick ? 100 : 1000);
    const streamed = await stallOver(run, bridge, owner, [thread], shapes.poor, stallSeconds, async (until) => {
      await sleep(Math.max(0, until - performance.now()));
    });
    await owner.call("session.interrupt", { session_id: thread });
    await ended;
    stallRows.push(stallRow("a reply streams", "poor", streamed));

    // Turns that each send a whole long reply at once, round the threads, for as long as the stall lasts.
    const flooded: string[] = [];
    for (let index = 0; index < floodThreads; index += 1) flooded.push((await owner.call("session.create", { profile: "fake", source: "tui" })).session_id as string);
    const flood = await stallOver(run, bridge, owner, flooded, shapes.wifi, stallSeconds, async (until) => {
      const running = new Map<string, Promise<unknown>>();
      for (let index = 0; performance.now() < until; index += 1) {
        const target = flooded[index % flooded.length];
        await running.get(target);
        const ended = owner.event("message.complete", target);
        running.set(target, ended);
        await owner.call("prompt.submit", { session_id: target, text: "bench instant", profile: "fake" });
        await sleep(floodGapMs);
      }
      await Promise.all(running.values());
    });
    stallRows.push(stallRow("a flood", "Wi-Fi", flood));

    run.say("network: a connection cut while a reply streams, over each link");
    for (const [name, shape] of [["poor", shapes.poor], ["Wi-Fi", shapes.wifi]] as const) {
      for (const [how] of cutCatchUps) cutRows.push(await cutOver(run, bridge, owner, thread, name, shape, how));
    }
    await owner.disconnect();
  } finally {
    await bridge.stop();
  }

  const shown = (shape: Shape) =>
    `${shape.latencyMs} ms each way, ${round((shape.down * 8) / 1_000_000)} Mbit/s down and ${round((shape.up * 8) / 1_000_000)} up, ${round(shape.loss * 100)}% of segments lost, ${round(shape.window / 1024)} KB held on the way before the bridge's socket backs up`;
  const linksNote = `The poor link: ${shown(shapes.poor)}. Wi-Fi: ${shown(shapes.wifi)}. A new connection waits ${shapes.poor.handshakes} round trips before its first byte (TCP's handshake and TLS's); a lost segment holds back what follows it for one more round trip.`;
  return [
    table(
      "network",
      "what a connect costs over a poor mobile link, the first time and every time after",
      ["Threads", "Connect", "Calls", "Bytes up", "Bytes down", "Bytes over the link up", "Bytes over the link down", "ms until quiet", "Slowest call", "Bridge CPU ms"],
      connectRows,
      [
        "The calls of `connect`, in the same order, one after another, from a device on the poor link. Bytes up and down are the payloads, as in `connect`; over the link are the bytes that crossed it: HTTP headers and WebSocket framing too, not TLS.",
        linksNote,
      ],
    ),
    table(
      "network",
      "how long a turn's end takes to reach a device on each link",
      ["Link", "Reply", "Events a turn", "Bytes over the link down a turn", "ms until a device on loopback sees the end", "ms until the device on the link sees it", "ms later than on loopback"],
      endRows,
      [
        `The device on the link sends the message and follows the thread; another on loopback follows it too. Times are from the moment the message was sent, the middle of ${turnsEach(run)} ${turnsEach(run) === 1 ? "turn" : "turns"}.`,
        `The short reply is about twenty words, ${recipe.delayMs} ms apart; the long one about 75, ${recipe.delayMs * 8} ms apart.`,
        "Each event crosses the link as a segment of its own, so a turn on the poor link loses one now and then, which holds the rest back a round trip. Which segments are lost is drawn from a fixed seed: every run loses the same ones.",
      ],
    ),
    table(
      "network",
      `what the bridge holds for a device that stops reading for ${stallSeconds} s`,
      [
        "What streams",
        "Link",
        "Stall s",
        "KB sent it meanwhile",
        "Most bytes waiting in a socket",
        "Bridge memory MB before",
        "at most",
        "once caught up",
        "Closed by the bridge",
        "ms from the stall's end until caught up",
        "Bridge CPU ms",
      ],
      stallRows,
      [
        "The device stops reading what comes from the bridge: what is on its way and what its own buffer holds wait for it, and past that the bridge's socket backs up. Then it reads again, and is caught up when it holds the last event the device on loopback held at that moment; a device whose connection went meanwhile connects again, opens every thread it follows again (session.resume) and asks for the events it missed (session.events.since). The app does that for the threads with a turn under way, and opens the others again when they are looked at.",
        `A reply streams: the scripted agent's minute-long reply, a few pieces of text a second with tool calls between. A flood: in ${floodThreads} threads the device follows, a turn every ${floodGapMs} ms that sends a whole long reply with its tool output at once (about 25 KB): far more than an agent sends, to see what the bridge holds when it is more than a few megabytes.`,
        `The stall lasts the time given and then until the bridge's next counters line, so that what they count is the stall's alone; most bytes waiting, the bridge's memory at most and its CPU are over the stall. Most bytes waiting is from the bridge's own lines, so it shows only with the counters on; it is read right after each frame. Memory is read every ${memoryEveryMs(run)} ms during the stall, and once more when the device caught up.`,
        linksNote,
      ],
    ),
    table(
      "network",
      "how long a device takes to catch up after its connection is cut while a reply streams",
      ["Link", "Catch-up", "Events missed", "ms until connected again", "ms until caught up", "Calls", "Bytes over the link up", "Bytes over the link down"],
      cutRows,
      [
        `${cutAfterMs(run) / 1000} s into the minute-long reply every connection over the link goes. The device connects again at once (a ticket, the socket, gateway.ready, client.capabilities) and catches up with the thread as the app does for one with a turn under way: before resume_replay it opens the thread again whole (session.resume) and asks for the events it missed (session.events.since); with it, it opens it again from the last event it holds, and the answer brings the events after it in place of the conversation. The app first waits half a second, and notices a connection that went silently only when its 45 s heartbeat finds nothing came.`,
        linksNote,
      ],
    ),
  ];
}
