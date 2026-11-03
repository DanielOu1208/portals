import { pathsFor } from "../../src/config.ts";
import { writeLinks } from "../../src/fleet/links.ts";
import { Device } from "./device.ts";
import { pick } from "./lines.ts";
import { recipe } from "./registry.ts";
import { bridgeWith, calls, inside, measured, median, round, table, type Cell, type Run, type Table } from "./run.ts";
import type { CommandRun } from "./scratch.ts";

// `fleet`: two bridges, the near one linked to the far one, which has N threads. A
// listing through the near bridge asks the far one each time, with a ticket, a new
// connection and the whole list: what that takes, and what crosses between the Macs.
// A read of one far thread crosses the same way, with its last turn's messages whole.
// Then the `portals` command itself, as an agent runs it.

export async function fleet(run: Run): Promise<Table[]> {
  const times = run.quick ? 3 : 20;
  const commands = run.quick ? 1 : 5;
  const listings: Cell[][] = [];
  const commandRows: Cell[][] = [];
  for (const size of run.sizes) {
    run.say(`fleet: listing ${size} threads on a linked bridge`);
    // The far Mac's first thread has the long last turn, for the read.
    const far = await bridgeWith(run, `far-${size}`, { threads: size, long: true });
    try {
      const near = await bridgeWith(run, `near-${size}`, { threads: 20 });
      try {
        // The bridge reads links.json again whenever it changes.
        writeLinks(pathsFor(near.bridge.home).links, [{ name: "far", url: far.bridge.url, user: far.bridge.account.username, password: far.bridge.account.password }]);
        const device = await Device.open(near.bridge);
        // What the device asks the near bridge, and what the near bridge then asks the far one.
        const asks = [
          { method: "threads.list", params: {}, passed: "threads.list" },
          { method: "machines.list", params: {}, passed: "profiles.list" },
          { method: "thread.read", params: { thread: `far/${far.written.ids[0]}` }, passed: "thread.read" },
        ];
        for (const { method, params, passed } of asks) {
          const mark = device.totals();
          const [here, there] = await measured(run, [near.bridge, far.bridge], async () => {
            for (let index = 0; index < times; index += 1) await device.call(method, params);
          });
          const asked = calls(device.since(mark), method);
          const per = (value: number) => value / times;
          listings.push([
            size,
            method,
            round(median(asked.ms)),
            round(per(asked.down)),
            inside(here.counted, per(pick(here.counted, "links", "0", "out"))),
            inside(here.counted, per(pick(here.counted, "links", "0", "in"))),
            inside(there.counted, per(pick(there.counted, "http", "ticket", "n") + pick(there.counted, "http", "login", "n"))),
            inside(here.counted, pick(here.counted, "links", "0", "signins")),
            inside(there.counted, per(pick(there.counted, "rpc", passed, "ms"))),
            inside(there.counted, per(pick(there.counted, "log", "n"))),
            inside(there.counted, per(pick(there.counted, "log", "bytes"))),
            round(per(here.cpuMs)),
            round(per(there.cpuMs)),
          ]);
        }

        const runs: CommandRun[] = [];
        for (let index = 0; index < commands; index += 1) {
          const ran = await run.scratch.portals(near.bridge.home, ["threads"]);
          if (ran.code !== 0) throw new Error(`portals threads failed: ${ran.stderr}`);
          runs.push(ran);
        }
        const printed = runs[0].stdout.length;
        commandRows.push([size, round(median(runs.map((ran) => ran.wallMs))), round(median(runs.map((ran) => ran.cpuMs))), round(median(runs.map((ran) => ran.peak))), printed, Math.round(printed / 4)]);
        await device.disconnect();
      } finally {
        await near.bridge.stop();
      }
    } finally {
      await far.bridge.stop();
    }
  }
  return [
    table(
      "fleet",
      `a call through a bridge linked to one with N threads, ${times} times each`,
      [
        "Threads on the far Mac",
        "Call",
        "ms a call (median)",
        "Answer bytes",
        "Bytes sent to the far Mac a call",
        "Bytes back a call",
        "Far Mac: HTTP requests a call",
        "Sign-ins in all",
        "Far Mac: ms in its part a call",
        "Far Mac: log lines a call",
        "Far Mac: log bytes a call",
        "Near CPU ms a call",
        "Far CPU ms a call",
      ],
      listings,
      [
        "The near bridge has 20 threads of its own. Each call is a ticket request, a new WebSocket, gateway.ready and one call to the far bridge; machines.list asks it for profiles.list.",
        `thread.read is of one far thread, whose last turn has a reply of ${recipe.longReply} characters, ${recipe.longReasoning} of reasoning and a tool's output of ${recipe.longToolOutput}: the turn's messages cross whole, and whoever asked (the portals command) cuts them afterwards. The first read loads the thread's session on the far Mac.`,
        "Bytes between the two hold the ticket's (and the one sign-in's) bodies and every frame, gateway.ready among them. They, the HTTP requests, the sign-ins, the far Mac's own time and what it wrote to its log (a line for the connection opened and one for it closed) are from the bridges' own lines, so they show only with the counters on.",
      ],
    ),
    table(
      "fleet",
      `the portals command: \`portals threads\` on the near bridge, ${commands} ${commands === 1 ? "time" : "times"}`,
      ["Threads on the far Mac", "Wall ms (median)", "CPU ms", "Most memory MB", "Characters printed", "About that many tokens"],
      commandRows,
      [
        "The launcher the bridge writes (a shell script that starts node on the command), timed with /usr/bin/time, whose CPU time is to a hundredth of a second.",
        "The command prints the newest 50 threads however many there are; a token is taken as four characters.",
      ],
    ),
  ];
}
