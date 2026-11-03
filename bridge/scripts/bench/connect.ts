import { Device } from "./device.ts";
import { pick, type Counted } from "./lines.ts";
import { recipe } from "./registry.ts";
import { all, bridgeWith, calls, inside, measured, round, table, type Cell, type Measured, type Run, type Table } from "./run.ts";
import { pushIdentity, watchForPush, type PushIdentity } from "./turns.ts";

// `connect`: everything a device sends when it connects, in the app's order
// (HostModel.swift, Fleet.swift, HermesConnection.swift). Two rows a size: the first
// connect of a device that holds nothing, and a later one, which is what every return
// to the foreground costs while no turn is under way in the open thread: the sign-in
// is kept, the list is asked for only since the revision held, the open thread is
// opened again whole, and what the agent offers is not asked for a second time.

/** The files a line can say were written, as "threads ×2, push ×1". */
function written(counted: Counted | null): Cell {
  if (!counted) return null;
  const files = (counted.sections.files ?? {}) as Record<string, { w?: number }>;
  const parts = Object.entries(files).flatMap(([file, counts]) => (counts.w ? [`${file} ×${counts.w}`] : []));
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * What the app sends once it is connected, in its order; `again` for a device that was
 * connected before. `thread` is the one on screen; `watched`, the threads the device
 * registers for notifications.
 */
export async function afterConnecting(device: Device, thread: string, identity: PushIdentity, watched: { id: string; title: string }[], again: boolean): Promise<void> {
  await device.call("profiles.list");
  await device.call("folders.list", { profile: "fake" });
  // The poll: the activity, and the list when its revision is not the one held.
  await device.poll();
  await watchForPush(device, identity, watched);
  // The thread on screen. With no turn under way when the connection went, the app
  // opens it again whole and asks for no events (HermesBackend.reattachThreads); one
  // with a turn under way is resumed and then asks for the events it missed
  // (session.events.since), which no row here has.
  await device.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  // The agent's models and commands are kept once they are had
  // (HostModel.loadOfferings), and a bridge's agent always has a command, /status.
  if (again) return;
  await device.call("model.options", { profile: "fake" });
  await device.call("config.get", { key: "reasoning", profile: "fake" });
  await device.call("commands.catalog", { profile: "fake" });
}

export async function connect(run: Run): Promise<Table[]> {
  const registered = run.quick ? 5 : 50;
  const rows: Cell[][] = [];
  for (const size of run.sizes) {
    run.say(`connect: a first connect and a later one, with ${size} threads`);
    const { bridge, written: registry } = await bridgeWith(run, `connect-${size}`, { threads: size });
    try {
      // Another device's thread, with a turn done, is the one open on the device measured.
      const other = await Device.open(bridge);
      const thread = (await other.call("session.create", { profile: "fake", source: "tui" })).session_id as string;
      const aTurn = async () => {
        const ended = other.event("message.complete", thread);
        await other.call("prompt.submit", { session_id: thread, text: recipe.prompt, profile: "fake" });
        await ended;
      };
      await aTurn();
      const watched = registry.ids.slice(0, registered).map((id) => ({ id, title: "A thread this device started, with a title of usual length" }));

      const device = new Device(bridge);
      const identity = pushIdentity();
      const burst = (again: boolean) => afterConnecting(device, thread, identity, watched, again);
      const row = (name: string, result: Measured, mark: ReturnType<Device["totals"]>): Cell[] => {
        const counted = device.since(mark);
        const sum = all(counted);
        const slowest = [...counted.calls].map(([method, stats]) => ({ method, ms: Math.max(...stats.ms) })).sort((a, b) => b.ms - a.ms)[0];
        const fetched = calls(counted, "threads.changes");
        return [
          size,
          name,
          sum.n,
          sum.up,
          sum.down,
          round(result.wallMs),
          `${slowest.method} ${round(slowest.ms)} ms`,
          round(calls(counted, "folders.list").ms[0] ?? 0),
          fetched.n === 0 ? "not asked" : fetched.down,
          round(result.cpuMs),
          written(result.counted),
          inside(result.counted, pick(result.counted, "files", "push", "w_bytes")),
        ];
      };

      let mark = device.totals();
      const [first] = await measured(run, [bridge], async () => {
        await device.signIn();
        await device.connect();
        await burst(false);
      });
      rows.push(row("first", first, mark));

      // While the device follows the thread a turn runs, so it has seen events; then it
      // goes away, and one more turn runs without it.
      await aTurn();
      await device.disconnect();
      await aTurn();

      mark = device.totals();
      const [later] = await measured(run, [bridge], async () => {
        await device.connect();
        await burst(true);
      });
      rows.push(row("again", later, mark));
      await Promise.all([device.disconnect(), other.disconnect()]);
    } finally {
      await bridge.stop();
    }
  }
  return [
    table(
      "connect",
      "what a device sends when it connects, the first time and every time after",
      ["Threads", "Connect", "Calls", "Bytes up", "Bytes down", "ms until quiet", "Slowest call", "folders.list ms", "threads.changes answer bytes", "Bridge CPU ms", "Files written", "push.json bytes written"],
      rows,
      [
        `First: sign-in, ticket, socket, client.capabilities, profiles.list, folders.list, sessions.activity, the whole list (threads.changes), the push registration with ${registered} threads, session.resume of one thread, model.options, config.get, commands.catalog. Again: the same without the sign-in and without the last three, which the app keeps, with the list asked for since the revision held (two turns ran in one thread meanwhile). No turn is under way in the open thread; with one, the app also asks for the events it missed (session.events.since) after the resume.`,
        "The calls are made one after another, so the time is an upper bound for the app, which makes some of them side by side. Calls counts the HTTP requests too.",
        "The threads' folders are in the harness's scratch folder. In a temporary folder (the default) none is ever offered, so folders.list answers with General alone, after looking at each of them: its time is that of going through the list's threads and asking the disk about their twenty folders, with no agent's own list of folders in it.",
        "Files written is from the bridge's own lines, so it shows only with the counters on.",
      ],
    ),
  ];
}
