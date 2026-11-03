// A scratch bridge for measuring the app (scripts/app-footprint.sh): the scripted agent
// only, on a port of the caller's, in a scratch home, with a list of threads written
// before it starts. It never touches an installed bridge: it refuses any home outside
// /private/tmp or /tmp, or one that has anything in it already (a link in it could lead
// out), and PORTALS_BRIDGE_HOME is always that home.
//
//   node scripts/app-footprint/bridge.mts start <home> <port> <threads> [password] [longEvery] [turns]
//       writes the list (bridge/scripts/bench/registry.ts: <threads> threads over 20
//       folders, the newest with a long last turn, every <longEvery>th (10) a long one of
//       <turns> (20) turns, each with a tool row and a reply with a list and code), then
//       runs the bridge in the foreground until it is killed.
//   node scripts/app-footprint/bridge.mts turns <url> <password> <thread> <n> [prompt]
//       runs <n> turns of the scripted agent in <thread>, one after another, as another
//       device would, and prints how long each took.
//
// The scripted agent's pace is `fake.delayMs` (25 ms a word here: a reply streams for a
// few seconds, the way a real one arrives).

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathsFor } from "../../bridge/src/config.ts";
import { hashPassword } from "../../bridge/src/http/auth.ts";
import { writeRegistry } from "../../bridge/scripts/bench/registry.ts";
import { Device } from "../../bridge/scripts/bench/device.ts";

const main = fileURLToPath(new URL("../../bridge/src/main.ts", import.meta.url));
const [command, ...args] = process.argv.slice(2);

// The scratch home by its real path. Checked before anything is made: no "..", the
// deepest folder of it that exists is under /private/tmp by its real path, and the home
// itself is new or empty, so that nothing in it can be a link leading out.
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

async function start(): Promise<void> {
  const [homeArg, portArg, threadsArg, passwordArg, longEveryArg, turnsArg] = args;
  const longEvery = Number(longEveryArg ?? 10);
  const longTurns = Number(turnsArg ?? 20);
  const home = scratchOnly(homeArg);
  const port = Number(portArg);
  if (![9342, 9352].includes(port)) throw new Error("the lean track's ports are 9342 and 9352");
  const threads = Number(threadsArg ?? 400);
  const password = passwordArg ?? "lean-footprint";
  const paths = pathsFor(home);
  mkdirSync(paths.state, { recursive: true });
  const folders = join(home, "folders");
  const written = writeRegistry(home, folders, { threads, long: true });
  // Every `longEvery`th thread is a long one: a tool row in each turn, replies with
  // lists and code.
  written.ids.forEach((id, index) => {
    if (index % longEvery !== Math.min(5, longEvery - 1)) return;
    const messages: unknown[] = [];
    const base = Math.floor(Date.now() / 1000) - 3600 * 24;
    for (let turn = 0; turn < longTurns; turn += 1) {
      messages.push({ role: "user", text: prose(90, turn + index), timestamp: base + turn * 60 });
      messages.push({ role: "tool", name: "terminal", args: { command: `npm test -- part ${turn}` }, content: prose(1500, turn), tool_call_id: `t-${index}-${turn}`, timestamp: base + turn * 60 + 10 });
      const reply = `Here is what I found:\n\n- ${prose(120, turn)}\n- ${prose(140, turn + 1)}\n\n\`\`\`swift\nlet x = ${turn}\nprint(x)\n\`\`\`\n\n${prose(900, turn + 2)}`;
      messages.push({ role: "assistant", text: reply, reasoning: prose(300, turn + 3), timestamp: base + turn * 60 + 30 });
    }
    writeFileSync(join(paths.fake, `${id}.json`), JSON.stringify({ messages, titled: true }), { mode: 0o600 });
  });
  writeFileSync(join(home, "ids.txt"), written.ids.join("\n") + "\n");
  mkdirSync(join(home, "general"), { recursive: true });
  const config = {
    port,
    auth: { username: "lean", passwordHash: await hashPassword(password) },
    generalFolder: join(home, "general"),
    providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: true },
    fake: { delayMs: 25 },
    aeri: { enabled: false },
    push: { relay: null, dryRun: join(home, "notifications.jsonl") },
    counters: { enabled: false },
  };
  writeFileSync(paths.config, JSON.stringify(config, null, 1), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, PORTALS_BRIDGE_HOME: home, PORTALS_BRIDGE_LOG: "info" };
  for (const key of ["AERIPORTAL_BRIDGE_HOME", "AERIPORTAL_BRIDGE_LOG", "PORTALS_THREAD", "NODE_TEST_CONTEXT"]) delete env[key];
  console.log(`scratch bridge: ${home}, http://127.0.0.1:${port}, ${threads} threads, user lean`);
  const child = spawn(process.execPath, [main], { env, stdio: "inherit" });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function turns(): Promise<void> {
  const [url, password, thread, countArg, prompt] = args;
  const device = await Device.open({ url, account: { username: "lean", password } });
  const resumed = await device.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  const session = (resumed?.session_id as string | undefined) ?? thread;
  const count = Number(countArg ?? 1);
  for (let turn = 0; turn < count; turn += 1) {
    const started = Date.now();
    const done = device.event("message.complete", session);
    await device.call("prompt.submit", { session_id: session, text: prompt ?? `Turn ${turn + 1}: a slow reply please`, profile: "fake" });
    await done;
    console.log(`turn ${turn + 1}: ${Date.now() - started} ms`);
  }
  await device.disconnect();
}

if (command === "start") await start();
else if (command === "turns") await turns();
else {
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 16).join("\n"));
  process.exit(2);
}
