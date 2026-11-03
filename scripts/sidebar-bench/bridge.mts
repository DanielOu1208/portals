// A scratch bridge for measuring the sidebar (docs/perf-sidebar.md): the scripted agent
// only, listed as several agents, with a long list of threads written before it starts.
// It never touches an installed bridge: it refuses any home outside /private/tmp, or one
// that has anything in it already (a link in it could lead out), and PORTALS_BRIDGE_HOME
// is always that home. Run with the bridge's own Node (from the repo's root):
//
//   node scripts/sidebar-bench/bridge.mts start <home> <port> <threads> [password] [agents] [folders] [unseen] [pinned]
//       writes the list: <threads> threads (600) over <agents> agents (5) and <folders>
//       folders (8), 25 minutes apart, newest first. One in <unseen> (10) is unseen (it
//       shows under Recent with its dot), one in <pinned> (20; 0 for none) pinned, one in 25 archived, one in 40 a long one of
//       20 turns with tool rows, and the newest ends with a long turn (a reply of
//       20,000 characters). Then runs the bridge in the foreground until killed.
//       The ids are in <home>/ids.txt, newest first, and in <home>/unseen.txt.
//   node scripts/sidebar-bench/bridge.mts turn <url> <password> <thread> [prompt]
//       one turn of the scripted agent in <thread>, as another device would start it:
//       the thread goes to Running, and to Finished when it ends.
//   node scripts/sidebar-bench/bridge.mts rename <url> <password> <thread> <title>
//       gives the thread a title, as another device would.
//   node scripts/sidebar-bench/bridge.mts calls <url> <password> [rounds]
//       times the list calls a device makes (threads.changes whole, sessions.activity,
//       threads.list) and prints their sizes: what the app waits for at launch.
//
// The ports are the sidebar track's, 9353 and 9363, and the tabs bench's, 9501 to 9509
// (scripts/tabs-bench.sh), and the other nines from 9511 to 9619 (9511 to 9519, 9521 to 9529
// and so on) for other agents' benches side by side.

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { pathsFor } from "../../bridge/src/config.ts";
import { hashPassword } from "../../bridge/src/http/auth.ts";
import { writeJSON } from "../../bridge/src/store/jsonFile.ts";
import { FakeProvider } from "../../bridge/src/providers/fake.ts";
import { Device } from "../../bridge/scripts/bench/device.ts";

const main = fileURLToPath(new URL("../../bridge/src/main.ts", import.meta.url));
const [command, ...args] = process.argv.slice(2);
const user = "sidebar";

function scratchOnly(home: string): string {
  const underTmp = (path: string) => path === "/private/tmp" || path.startsWith("/private/tmp/");
  if (home.split("/").includes("..")) throw new Error(`refused: ${home} has a .. in it`);
  const absolute = resolve(home);
  let existing = absolute;
  while (!existsSync(existing)) existing = dirname(existing);
  if (!underTmp(realpathSync(existing))) throw new Error(`refused: ${home} is not under /private/tmp`);
  if (existsSync(absolute) && (lstatSync(absolute).isSymbolicLink() || readdirSync(absolute).length > 0)) {
    throw new Error(`refused: ${home} is a link or has something in it already: give a new home`);
  }
  mkdirSync(absolute, { recursive: true });
  const real = realpathSync(absolute);
  if (!real.startsWith("/private/tmp/")) throw new Error(`refused: ${real} is not under /private/tmp`);
  return real;
}

const words = "sync fleet thread bridge poll merge counters revision device sidebar archive rename pinned window build review plan budget list write change update remove agent session folder project notes draft report".split(" ");
function prose(length: number, salt: number): string {
  let made = "";
  let index = salt;
  while (made.length < length) {
    made += (made === "" ? "" : index % 17 === 0 ? ".\n\n" : " ") + words[(index * 7 + 3) % words.length];
    index += 1;
  }
  return made;
}

function id(index: number): string {
  const hex = (index + 1).toString(16).padStart(12, "0");
  return `51deba00-0000-4000-8000-${hex}`;
}

async function start(): Promise<void> {
  const [homeArg, portArg, threadsArg, passwordArg, agentsArg, foldersArg, unseenArg, pinnedArg] = args;
  const home = scratchOnly(homeArg);
  const port = Number(portArg);
  if (![9353, 9363].includes(port) && !(port >= 9501 && port <= 9619 && port % 10 !== 0)) {
    throw new Error("the benches' ports are 9353, 9363, and 9501 to 9619 except the multiples of ten (9501 to 9509, 9511 to 9519, and so on)");
  }
  const count = Number(threadsArg ?? 600);
  const password = passwordArg ?? "sidebar-bench";
  const agents = Number(agentsArg ?? 5);
  const folderCount = Number(foldersArg ?? 8);
  const unseenEvery = Number(unseenArg ?? 10);
  const pinnedEvery = Number(pinnedArg ?? 20);
  const paths = pathsFor(home);
  mkdirSync(paths.fake, { recursive: true, mode: 0o700 });
  const folders = Array.from({ length: folderCount }, (_, index) => join(home, "folders", `project-${String(index + 1).padStart(2, "0")}`));
  for (const folder of folders) mkdirSync(folder, { recursive: true });
  mkdirSync(join(home, "general"), { recursive: true });

  const now = Math.floor(Date.now() / 1000);
  const records: Record<string, unknown>[] = [];
  const unseen: string[] = [];
  for (let index = 0; index < count; index += 1) {
    // 25 minutes apart: 600 threads go back ten days, so the older rows show a date.
    const updatedAt = now - 120 - index * 1500;
    const thread = id(index);
    const record: Record<string, unknown> = {
      id: thread,
      agent: FakeProvider.nameFor((index % agents) + 1),
      cwd: folders[(index * 7 + Math.floor(index / agents)) % folders.length],
      title: `${prose(30 + (index % 50), index).replace(/\s+/g, " ")} ${index + 1}`,
      model: "fake-1",
      provider: "fake",
      reasoningEffort: "medium",
      createdAt: updatedAt - 3600,
      updatedAt,
      origin: "phone",
      preview: prose(60 + (index % 80), index + 3).replace(/\s+/g, " "),
      revision: count - index,
      turnRevision: count - index,
    };
    if (index % unseenEvery === 4) { record.unseen = true; unseen.push(thread); }
    if (pinnedEvery > 0 && index % pinnedEvery === 3) record.pinned = true;
    if (index % 25 === 11) record.archived = true;
    records.push(record);
    const messages: unknown[] = [];
    const turns = index % 40 === 7 ? 20 : 1;
    for (let turn = 0; turn < turns; turn += 1) {
      const at = updatedAt - (turns - turn) * 60;
      messages.push({ role: "user", text: prose(90, turn + index), timestamp: at });
      if (turns > 1) {
        messages.push({ role: "tool", name: "terminal", args: { command: `npm test -- part ${turn}` }, content: prose(1500, turn), tool_call_id: `t-${index}-${turn}`, timestamp: at + 10 });
      }
      messages.push({ role: "assistant", text: `Here is what I found:\n\n- ${prose(120, turn)}\n- ${prose(140, turn + 1)}\n\n${prose(turns > 1 ? 900 : 300, turn + 2)}`, timestamp: at + 30 });
    }
    // The newest one ends with a long turn, as the footprint bench's (registry.ts): a
    // reply of 20,000 characters, 10,000 of a tool's output, 2,000 of reasoning.
    if (index === 0) {
      messages.push({ role: "user", text: prose(90, 1), timestamp: updatedAt - 20 });
      messages.push({ role: "tool", name: "terminal", args: { command: "npm test" }, content: prose(10_000, 2), tool_call_id: "long-tool", timestamp: updatedAt - 10 });
      messages.push({ role: "assistant", text: prose(20_000, 3), reasoning: prose(2000, 4), timestamp: updatedAt });
    }
    writeFileSync(join(paths.fake, `${thread}.json`), JSON.stringify({ messages, titled: true }), { mode: 0o600 });
  }
  writeJSON(paths.threads, { list: "51deba7bench0001", revision: count, threads: records });
  writeFileSync(join(home, "ids.txt"), records.map((record) => record.id).join("\n") + "\n");
  writeFileSync(join(home, "unseen.txt"), unseen.join("\n") + "\n");
  const config = {
    port,
    auth: { username: user, passwordHash: await hashPassword(password) },
    generalFolder: join(home, "general"),
    providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: true },
    fake: { delayMs: 25, agents },
    aeri: { enabled: false },
    push: { relay: null, dryRun: join(home, "notifications.jsonl") },
    // No standby socket to the deployed relay from a scratch bridge.
    relay: { enabled: false },
    counters: { enabled: false },
  };
  writeFileSync(paths.config, JSON.stringify(config, null, 1), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, PORTALS_BRIDGE_HOME: home, PORTALS_BRIDGE_LOG: "info" };
  for (const key of ["AERIPORTAL_BRIDGE_HOME", "AERIPORTAL_BRIDGE_LOG", "PORTALS_THREAD", "NODE_TEST_CONTEXT"]) delete env[key];
  console.log(`scratch bridge: ${home}, http://127.0.0.1:${port}, ${count} threads over ${agents} agents and ${folderCount} folders, user ${user}`);
  const child = spawn(process.execPath, [main], { env, stdio: "inherit" });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function device(url: string, password: string): Promise<Device> {
  return Device.open({ url, account: { username: user, password } });
}

async function turn(): Promise<void> {
  const [url, password, thread, prompt] = args;
  const peer = await device(url, password);
  const listed = (await peer.call("threads.list", { local: true })) as { threads: { id: string; agent: string }[] };
  const agent = listed.threads.find((record) => record.id === thread)?.agent ?? "fake";
  const resumed = await peer.call("session.resume", { session_id: thread, profile: agent, inline_images: false });
  const session = (resumed?.session_id as string | undefined) ?? thread;
  const started = Date.now();
  const done = peer.event("message.complete", session);
  await peer.call("prompt.submit", { session_id: session, text: prompt ?? "think tool please", profile: agent });
  await done;
  console.log(`turn: ${Date.now() - started} ms`);
  await peer.disconnect();
}

async function rename(): Promise<void> {
  const [url, password, thread, title] = args;
  const peer = await device(url, password);
  await peer.call("session.rename", { session_id: thread, title });
  await peer.disconnect();
}

async function calls(): Promise<void> {
  const [url, password, roundsArg] = args;
  const rounds = Number(roundsArg ?? 5);
  const peer = await device(url, password);
  const timed = async (method: string, params: Record<string, unknown>) => {
    const times: number[] = [];
    let bytes = 0;
    for (let round = 0; round < rounds; round += 1) {
      const started = performance.now();
      const answer = await peer.call(method, params);
      times.push(performance.now() - started);
      bytes = JSON.stringify(answer).length;
    }
    times.sort((a, b) => a - b);
    console.log(`${method} ${JSON.stringify(params)}: median ${times[Math.floor(times.length / 2)].toFixed(1)} ms, ${(bytes / 1024).toFixed(1)} KB`);
  };
  await timed("threads.changes", {});
  await timed("sessions.activity", {});
  await timed("threads.list", { local: true });
  await peer.disconnect();
}

if (command === "start") await start();
else if (command === "turn") await turn();
else if (command === "rename") await rename();
else if (command === "calls") await calls();
else {
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 24).join("\n"));
  process.exit(2);
}
