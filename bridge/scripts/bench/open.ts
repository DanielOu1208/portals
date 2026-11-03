import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Device } from "./device.ts";

// The bridge's half of scripts/open-bench.sh: threads of several shapes on a scratch
// bridge with only the scripted fake agent, a turn running in one of them while the app
// opens it, and what the bridge sends when a thread is opened. The shell script starts
// and stops the bridge (with scroll.ts config).
//
//   node scripts/bench/open.ts seed <url> <user> <password> <out.json>
//       makes the threads and writes their ids to <out.json>: t1, t10, t45 and t120 (that
//       many turns of the fake agent's long reply, fakeBench.ts: headings, lists, code,
//       a table, math, tool calls with diffs and output), long (five short turns, then a
//       very long last reply), approval (ten turns, then one waiting on an approval
//       card), running (ten turns; `run` starts its turn) and f1…f9 (one short turn
//       each, to push the others past the eight kept in memory).
//   node scripts/bench/open.ts run <url> <user> <password> <thread>
//       starts the fake agent's minute-long reply in <thread> and returns at once.
//   node scripts/bench/open.ts stop <url> <user> <password> <thread>
//       stops the turn running in <thread>.
//   node scripts/bench/open.ts fetch <url> <user> <password> <thread> [times]
//       opens <thread> as the app does (session.resume) <times> times (5) and prints the
//       answer's size and the median time, from the call to the whole answer parsed;
//       with BENCH_SAVE=<file>, the answer is written there as the app receives it.

const [command, ...args] = process.argv.slice(2);

async function turns(device: Device, thread: string, prompt: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const ended = device.event("message.complete", thread);
    await device.call("prompt.submit", { session_id: thread, text: `${prompt}, turn ${index + 1}`, profile: "fake" });
    await ended;
  }
}

async function create(device: Device, title: string): Promise<string> {
  const thread = (await device.call("session.create", { profile: "fake", source: "tui" })).session_id as string;
  await device.call("session.rename", { session_id: thread, title, profile: "fake" });
  return thread;
}

async function main(): Promise<void> {
  const [url, username, password, thread] = args;
  const device = await Device.open({ url, account: { username, password } });
  try {
    switch (command) {
      case "seed": {
        const out = thread;
        const ids: Record<string, string> = {};
        // Fillers first, so that the measured threads are the newest in the list.
        for (let index = 1; index <= 9; index += 1) {
          ids[`f${index}`] = await create(device, `Filler ${index}`);
          await turns(device, ids[`f${index}`], "hello", 1);
        }
        for (const count of [1, 10, 45, 120]) {
          const started = performance.now();
          ids[`t${count}`] = await create(device, `${count} turns`);
          await turns(device, ids[`t${count}`], "bench instant", count);
          console.error(`t${count}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
        }
        ids.long = await create(device, "Very long last reply");
        await turns(device, ids.long, "hello", 5);
        await turns(device, ids.long, "bench instant", 1);
        ids.running = await create(device, "Turn running");
        await turns(device, ids.running, "bench instant", 10);
        ids.approval = await create(device, "Waiting on approval");
        await turns(device, ids.approval, "bench instant", 10);
        const started = device.event("message.start", ids.approval);
        await device.call("prompt.submit", { session_id: ids.approval, text: "approve this please", profile: "fake" });
        await started;
        // The card is open once the fake agent has asked: a moment after its turn starts.
        await new Promise((done) => setTimeout(done, 1500));
        writeFileSync(out, JSON.stringify(ids, null, 1));
        return;
      }
      case "run": {
        await device.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
        const started = device.event("message.start", thread);
        await device.call("prompt.submit", { session_id: thread, text: "bench", profile: "fake" });
        await started;
        return;
      }
      case "stop": {
        await device.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
        await device.call("session.interrupt", { session_id: thread, profile: "fake" });
        return;
      }
      case "fetch": {
        const times = Number(args[4] ?? 5);
        const took: number[] = [];
        let bytes = 0;
        let messages = 0;
        for (let index = 0; index < times; index += 1) {
          const started = performance.now();
          const answer = await device.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
          took.push(performance.now() - started);
          bytes = Buffer.byteLength(JSON.stringify(answer));
          if (process.env.BENCH_SAVE) writeFileSync(process.env.BENCH_SAVE, JSON.stringify({ jsonrpc: "2.0", id: "r1", result: answer }));
          messages = Array.isArray(answer?.messages) ? answer.messages.length : 0;
        }
        took.sort((a, b) => a - b);
        console.log(JSON.stringify({ thread, bytes, messages, median_ms: Math.round(took[Math.floor(took.length / 2)]), runs: took.map(Math.round) }));
        return;
      }
      default:
        throw new Error("usage: open.ts seed|run|stop|fetch …");
    }
  } finally {
    await device.disconnect();
  }
}

await main();
