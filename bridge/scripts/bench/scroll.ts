import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathsFor } from "../../src/config.ts";
import { hashPassword } from "../../src/http/auth.ts";
import { Device } from "./device.ts";

// The bridge's half of scripts/mac-scroll-bench.sh: a scratch bridge's config, a thread
// with a long history, and the fake agent's minute-long reply (fakeBench.ts) streamed
// into it while the app is measured. The shell script starts and stops the bridge.
//
//   node scripts/bench/scroll.ts config <home> <port> <user> <password>
//   node scripts/bench/scroll.ts seed <url> <user> <password> <turns>     prints the thread id
//   node scripts/bench/scroll.ts stream <url> <user> <password> <thread>  returns when the reply is done
//
// BENCH_PROMPT replaces the prompt `stream` sends ("bench coarse": half as many pieces).
//
// `seed` makes the thread: <turns> turns of the same reply sent at once, each with its
// tool calls. `stream` sends `bench` into it and waits for the turn to end.

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (command) {
    case "config": {
      const [home, port, username, password] = args;
      mkdirSync(home, { recursive: true });
      const general = join(home, "general");
      mkdirSync(general, { recursive: true });
      const config = {
        port: Number(port),
        auth: { username, passwordHash: await hashPassword(password) },
        generalFolder: general,
        providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: true },
        push: { relay: null, dryRun: join(home, "notifications.jsonl") },
        relay: { enabled: false },
        updates: { check: false },
        counters: { enabled: false },
      };
      writeFileSync(pathsFor(home).config, JSON.stringify(config, null, 1), { mode: 0o600 });
      return;
    }
    case "seed": {
      const [url, username, password, turns] = args;
      const device = await Device.open({ url, account: { username, password } });
      const thread = (await device.call("session.create", { profile: "fake", source: "tui" })).session_id as string;
      for (let index = 0; index < Number(turns); index += 1) {
        const ended = device.event("message.complete", thread);
        await device.call("prompt.submit", { session_id: thread, text: `bench instant, turn ${index + 1}`, profile: "fake" });
        await ended;
      }
      await device.disconnect();
      console.log(thread);
      return;
    }
    case "stream": {
      const [url, username, password, thread] = args;
      const device = await Device.open({ url, account: { username, password } });
      await device.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
      const started = performance.now();
      const ended = waitLong(device, thread);
      await device.call("prompt.submit", { session_id: thread, text: process.env.BENCH_PROMPT ?? "bench", profile: "fake" });
      await ended;
      console.log(`streamed in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      await device.disconnect();
      return;
    }
    default:
      throw new Error("usage: scroll.ts config|seed|stream …");
  }
}

/** The turn's end, however long it takes: the device gives up on an event after a minute. */
async function waitLong(device: Device, thread: string): Promise<void> {
  for (;;) {
    try {
      await device.event("message.complete", thread);
      return;
    } catch (error) {
      if (!/no message.complete event/.test((error as Error).message)) throw error;
    }
  }
}

await main();
process.exit(0);
