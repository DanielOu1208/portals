import { setTimeout as sleep } from "node:timers/promises";
import { Device, type CatchUp } from "./device.ts";
import { recipe } from "./registry.ts";
import { bridgeWith, measured, median, round, table, type Cell, type Run, type Table } from "./run.ts";
import type { BenchBridge } from "./scratch.ts";

// `resume`: a device taking up again a thread with a long conversation that it followed,
// the two ways the app does: on a reconnect while a turn runs in it (HermesBackend.resync),
// and as the app comes back to the front with the thread on screen at rest
// (HermesBackend.catchUp, ThreadController). Each the way the app did before
// `resume_replay`, with the whole conversation (and, for the turn under way, the events
// missed asked for after it), and the way it does with it: only the events missed, in the
// answer to the resume. And a short thread back at the front, whose events missed would
// take more than its whole conversation: the bridge answers it whole.

/** Stored messages in the thread's conversation, besides its long last turn. */
function messagesFor(run: Run): number {
  return run.quick ? 20 : 400;
}

/** Each case is measured this many times each way; the middle is shown. */
function roundsFor(run: Run): number {
  return run.quick ? 1 : 3;
}

/** How long the device is away while a turn runs, in milliseconds. */
function awayMs(run: Run): number {
  return run.quick ? 50 : 500;
}

interface Taken {
  missed: number | null;
  calls: number;
  up: number;
  down: number;
  ms: number;
  cpuMs: number;
}

/** A turn by `owner`, which `followers` see end too. */
async function aTurn(owner: Device, thread: string, followers: Device[] = [], text: string = recipe.prompt): Promise<void> {
  const ended = [owner, ...followers].map((device) => device.event("message.complete", thread));
  await owner.call("prompt.submit", { session_id: thread, text, profile: "fake" });
  await Promise.all(ended);
}

/** The catch-up alone, after the device connected again: its calls, what they carried and what the bridge spent. */
async function takeUp(run: Run, bridge: BenchBridge, phone: Device, thread: string, how: CatchUp): Promise<Taken> {
  const mark = phone.totals();
  let missed: number | null = null;
  const [result] = await measured(run, [bridge], async () => {
    missed = await phone.catchUp(thread, how);
  });
  const counted = phone.since(mark);
  const sum = { calls: 0, up: 0, down: 0 };
  for (const stats of counted.calls.values()) {
    sum.calls += stats.n;
    sum.up += stats.up;
    sum.down += stats.down;
  }
  return { missed, ...sum, ms: result.wallMs, cpuMs: result.cpuMs };
}

/** The thread at rest: a turn while the device follows it, then one while it is in the background (`away` sent), and back. */
async function backToTheFront(run: Run, bridge: BenchBridge, owner: Device, phone: Device, thread: string, how: CatchUp, away: string = recipe.prompt): Promise<Taken> {
  await aTurn(owner, thread, [phone]);
  await phone.disconnect();
  await aTurn(owner, thread, [], away);
  await phone.connect();
  return takeUp(run, bridge, phone, thread, how);
}

/** A turn under way: the device follows it a moment, loses its connection for a while, and connects again. */
async function reconnectMidTurn(run: Run, bridge: BenchBridge, owner: Device, phone: Device, thread: string, how: CatchUp): Promise<Taken> {
  const ended = owner.event("message.complete", thread);
  const started = phone.event("message.start", thread);
  await owner.call("prompt.submit", { session_id: thread, text: "bench", profile: "fake" });
  await started;
  await sleep(awayMs(run));
  await phone.disconnect();
  await sleep(awayMs(run));
  await phone.connect();
  const taken = await takeUp(run, bridge, phone, thread, how);
  const seen = phone.event("message.complete", thread);
  await owner.call("session.interrupt", { session_id: thread });
  await Promise.all([ended, seen]);
  return taken;
}

export async function resume(run: Run): Promise<Table[]> {
  const rows: Cell[][] = [];
  const { bridge, written } = await bridgeWith(run, "resume", { threads: 10, messages: messagesFor(run), long: true });
  let conversation = 0;
  let shortConversation = 0;
  try {
    // The thread with the long conversation; another device sends its turns.
    const thread = written.ids[0];
    const owner = await Device.open(bridge);
    await owner.resume(thread);
    const phone = await Device.open(bridge);
    const opened = phone.totals();
    await phone.resume(thread);
    conversation = phone.since(opened).calls.get("session.resume")?.down ?? 0;
    // A short thread: one turn, then those of its rounds.
    const short = (await owner.call("session.create", { profile: "fake", source: "tui" })).session_id as string;
    await aTurn(owner, short);
    const shortOpened = phone.totals();
    await phone.resume(short);
    shortConversation = phone.since(shortOpened).calls.get("session.resume")?.down ?? 0;

    const cases: [string, (how: CatchUp) => Promise<Taken>, [CatchUp, string][]][] = [
      [
        "a reconnect while a turn runs",
        (how) => reconnectMidTurn(run, bridge, owner, phone, thread, how),
        [
          ["since", "before: the whole session.resume, then session.events.since"],
          ["replay", "after: session.resume from the last event held"],
        ],
      ],
      [
        "back at the front, the thread at rest",
        (how) => backToTheFront(run, bridge, owner, phone, thread, how),
        [
          ["whole", "before: the whole session.resume"],
          ["replay", "after: session.resume from the last event held"],
        ],
      ],
      [
        "back at the front, a short thread, a reply streamed while away",
        // Followed again first: the case before left it with only the long one.
        async (how) => {
          await phone.resume(short);
          return backToTheFront(run, bridge, owner, phone, short, how, recipe.slowPrompt);
        },
        [
          ["whole", "before: the whole session.resume"],
          ["replay", "after: session.resume from the last event held"],
        ],
      ],
    ];
    for (const [name, take, ways] of cases) {
      run.say(`resume: ${name}, ${roundsFor(run)} ${roundsFor(run) === 1 ? "time" : "times"} each way`);
      const taken = new Map<CatchUp, Taken[]>(ways.map(([how]) => [how, []]));
      // Each way in turn, so that both meet a conversation of about the same length.
      for (let index = 0; index < roundsFor(run); index += 1) {
        for (const [how] of ways) taken.get(how)!.push(await take(how));
      }
      for (const [how, shown] of ways) {
        const all = taken.get(how)!;
        const middle = (pick: (one: Taken) => number) => round(median(all.map(pick)));
        const missed = all.map((one) => one.missed).filter((count): count is number => count !== null);
        rows.push([
          name,
          shown,
          missed.length === all.length ? round(median(missed)) : "all (whole thread)",
          middle((one) => one.calls),
          middle((one) => one.up),
          middle((one) => one.down),
          middle((one) => one.ms),
          middle((one) => one.cpuMs),
        ]);
      }
    }
    await Promise.all([owner.disconnect(), phone.disconnect()]);
  } finally {
    await bridge.stop();
  }
  return [
    table(
      "resume",
      "what taking up a thread again costs, with a long conversation and a short one, before and after resume_replay",
      ["Case", "Catch-up", "Events missed", "Calls", "Bytes up", "Bytes down", "ms", "Bridge CPU ms"],
      rows,
      [
        `The thread has ${messagesFor(run)} stored messages and a long last turn (a ${recipe.longReply / 1000} KB reply, ${recipe.longToolOutput / 1000} KB of tool output): its whole session.resume answer was ${conversation} bytes when the device first opened it, and grows with each turn here. The short thread is one turn when the device first opens it (its whole answer ${shortConversation} bytes), and two more each time it is measured, the one while the device is away a reply streamed in many small pieces ("${recipe.slowPrompt}"). Another device on loopback sends the turns; the device measured is on loopback too, and follows the thread.`,
        `A reconnect while a turn runs: ${awayMs(run)} ms into the minute-long reply the device's connection goes, and ${awayMs(run)} ms later it connects again (not measured) and catches up as the app does for a thread with a turn under way. Back at the front: a turn while it follows the thread, one while it is in the background, then it connects again and catches up as the app does for the thread on screen at rest. Before resume_replay the app opens that thread whole and asks for no events.`,
        `Calls, bytes and time are the catch-up's alone, after the device connected again; bytes down are the answers', not the live events that come meanwhile. The middle of ${roundsFor(run)} ${roundsFor(run) === 1 ? "time" : "times"} each way, the two ways taken in turn. Bridge CPU is over the catch-up: in a reconnect while a turn runs, what the bridge does for the turn going on meanwhile is in it.`,
      ],
    ),
  ];
}
