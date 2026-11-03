// A third device for RecentThreadsUITests, against scratch bridges started with
// scripts/sidebar-bench/bridge.mts (whose user it signs in as). Threads are named by their
// place in that bridge's <home>/ids.txt, 1 being the one that last ran.
//
//   node scripts/phone-bench/uitest/recent-threads-tool.mts name <url> <password> <home> <prefix> <from> <to>
//       titles those threads "<prefix> <place>", which the UI test finds them by.
//   node scripts/phone-bench/uitest/recent-threads-tool.mts mark <url> <password> <home> <from> <to> <true|false>
//       puts them under Recent on every device, or takes them out.
//   node scripts/phone-bench/uitest/recent-threads-tool.mts list <url> <password>
//       prints the threads marked recent, the one that last ran first, and how many.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Device } from "../../../bridge/scripts/bench/device.ts";

const [command, url, password, ...args] = process.argv.slice(2);
const peer = await Device.open({ url, account: { username: "sidebar", password } });
const ids = (home: string) => readFileSync(join(home, "ids.txt"), "utf8").trim().split("\n");

if (command === "name") {
  const [home, prefix, from, to] = args;
  const all = ids(home);
  for (let place = Number(from); place <= Number(to); place += 1) {
    await peer.call("session.rename", { session_id: all[place - 1], title: `${prefix} ${place}` });
  }
} else if (command === "mark") {
  const [home, from, to, value] = args;
  const all = ids(home);
  for (let place = Number(from); place <= Number(to); place += 1) {
    await peer.call("thread.mark", { thread: all[place - 1], recent: value === "true" });
  }
} else if (command === "list") {
  const { threads } = (await peer.call("threads.changes", {})) as { threads: { title?: string; recent?: boolean; updated: number; unseen?: boolean }[] };
  const marked = threads.filter((thread) => thread.recent).sort((one, other) => other.updated - one.updated);
  console.log(`${marked.length} marked: ${marked.map((thread) => thread.title + (thread.unseen ? " (unseen)" : "")).join(", ")}`);
} else {
  throw new Error(`no such command: ${command}`);
}
await peer.disconnect();
process.exit(0);
