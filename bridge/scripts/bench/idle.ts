import { statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathsFor } from "../../src/config.ts";
import { Device } from "./device.ts";
import { all, bridgeWith, calls, round, table, type Run, type Table } from "./run.ts";

// `idle`: devices connected to a bridge and doing only what the app does at rest, a
// poll every five seconds and a heartbeat every fifteen. What a device and the bridge
// spend in a minute in which nothing happens. Each asks to be told to poll (feature
// poll_now), as the app does, and is told nothing at rest.

export interface IdleOptions {
  /** A name for the bridge's folder. */
  name: string;
  counters: boolean;
  threads: number;
  devices: number;
  /** How long is watched, after `settleSeconds` of the same. */
  seconds: number;
  settleSeconds: number;
  pollMs: number;
  heartbeatMs: number;
}

export interface IdleNumbers {
  /** Per device and minute. */
  calls: number;
  up: number;
  down: number;
  /** `threads.changes` calls by all the devices while watched: none at rest. */
  fetches: number;
  /** `poll.now` events all the devices heard while watched: none at rest. */
  told: number;
  /** State files that changed on disk while watched: none at rest. */
  filesChanged: number;
  /** The bridge's CPU milliseconds a minute. */
  cpuMs: number;
  rss: number;
  heap: number;
  /** Lines its counters wrote while watched: each is one tick whose cost is in `cpuMs`. */
  ticks: number;
}

/** What `idle` chooses for a run; `cost` runs the same with the counters off and on. */
export function idleOptions(run: Run, counters: boolean, name: string): IdleOptions {
  return run.quick
    ? { name, counters, threads: 50, devices: 2, seconds: 0.8, settleSeconds: 0.2, pollMs: 100, heartbeatMs: 300 }
    : { name, counters, threads: 1000, devices: 3, seconds: run.idleSeconds, settleSeconds: 10, pollMs: 5000, heartbeatMs: 15_000 };
}

export async function measureIdle(run: Run, options: IdleOptions): Promise<IdleNumbers> {
  // At the counters' real tick, a minute: a one-second tick would be most of an idle
  // bridge's CPU. (The test suite's short run has no minute to wait.)
  const { bridge } = await bridgeWith(run, options.name, { threads: options.threads }, { counters: options.counters, tick: run.quick ? run.tick : null });
  const devices: Device[] = [];
  try {
    for (let index = 0; index < options.devices; index += 1) {
      const device = await Device.open(bridge, { pushes: { waitMs: run.quick ? 100 : 1000 } });
      // The first poll takes the whole list; from then on the device holds its revision.
      await device.poll();
      device.startPolling(options.pollMs, options.heartbeatMs);
      devices.push(device);
    }
    await sleep(options.settleSeconds * 1000);

    const paths = pathsFor(bridge.home);
    const files = [paths.threads, paths.removed, paths.push];
    const stamp = () => files.map((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    const stamps = stamp();
    const marks = devices.map((device) => device.totals());
    const toldBefore = devices.map((device) => device.told);
    const linesBefore = bridge.lines?.all().length ?? 0;
    const before = await bridge.sample();
    await sleep(options.seconds * 1000);
    const after = await bridge.sample();
    const counted = devices.map((device, index) => device.since(marks[index]));

    const minutes = options.seconds / 60;
    const total = counted.map(all).reduce((sum, one) => ({ n: sum.n + one.n, up: sum.up + one.up, down: sum.down + one.down }), { n: 0, up: 0, down: 0 });
    return {
      calls: total.n / options.devices / minutes,
      up: total.up / options.devices / minutes,
      down: total.down / options.devices / minutes,
      fetches: counted.reduce((sum, one) => sum + calls(one, "threads.changes").n, 0),
      told: devices.reduce((sum, device, index) => sum + device.told - toldBefore[index], 0),
      filesChanged: stamp().filter((now, index) => now !== stamps[index]).length,
      cpuMs: (after.cpuMs - before.cpuMs) / minutes,
      rss: after.rss,
      heap: after.heap,
      ticks: (bridge.lines?.all().length ?? 0) - linesBefore,
    };
  } finally {
    await Promise.all(devices.map((device) => device.disconnect()));
    await bridge.stop();
  }
}

export async function idle(run: Run): Promise<Table[]> {
  const options = idleOptions(run, run.counters, "idle");
  run.say(`idle: ${options.devices} devices at rest for ${options.seconds} s`);
  const numbers = await measureIdle(run, options);
  return [
    table(
      "idle",
      `${options.devices} devices connected to a bridge with ${options.threads} threads, nothing happening`,
      ["Calls a device a minute", "Bytes up a device a minute", "Bytes down a device a minute", "threads.changes calls", "poll.now events", "State files written", "Bridge CPU ms a minute", "Bridge memory MB", "Bridge heap MB", "Counter ticks while watched"],
      [[round(numbers.calls), round(numbers.up), round(numbers.down), numbers.fetches, numbers.told, numbers.filesChanged, round(numbers.cpuMs), round(numbers.rss), round(numbers.heap), options.counters ? numbers.ticks : null]],
      [
        `Each device polls sessions.activity every ${options.pollMs / 1000} s and sends gateway.ping every ${options.heartbeatMs / 1000} s; watched for ${options.seconds} s after ${options.settleSeconds} s of the same. Each asks for poll.now, as the app does with a bridge that offers it.`,
        "threads.changes calls, poll.now events and state files written (threads.json, removed.json, push.json, by their change time) should all be 0.",
        "A harness bridge runs from the source, so its memory holds Node's own handling of TypeScript too; an installed bridge runs compiled JavaScript, and its lines say what it holds.",
        `The bridge's counters were ${options.counters ? `on, with a tick ${run.quick ? `every ${run.tick} s (the short run)` : "a minute apart, as installed"}: each tick while watched is in the CPU` : "off"}.`,
      ],
    ),
  ];
}
