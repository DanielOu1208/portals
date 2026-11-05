import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { FakeOpenCode } from "./opencode-serve.ts";

if (process.argv[2] === "--version") {
  console.log(process.env.OPENCODE_STANDIN_VERSION ?? "2.2.5");
  process.exit(0);
}
if (process.argv.includes("--service") && process.env.OPENCODE_STANDIN_WINNER && process.env.OPENCODE_STANDIN_REGISTRATION) {
  try { writeFileSync(process.env.OPENCODE_STANDIN_REGISTRATION, process.env.OPENCODE_STANDIN_WINNER, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  process.exit(0);
}

// A stand-in for `opencode serve` as the bridge runs one of its own (opencode.mode
// "own", or when OpenCode's background service cannot be had), for
// test/opencode-server.test.ts: it serves test/opencode-serve.ts with the password it
// is given, says where it listens as OpenCode does, and writes how it was started to
// $OPENCODE_STANDIN_ARGS. With $OPENCODE_STANDIN_FAIL set it fails before listening.
//
//   node test/opencode-standin.ts serve --hostname 127.0.0.1 --port 0

if (process.env.OPENCODE_STANDIN_ARGS) {
  writeFileSync(process.env.OPENCODE_STANDIN_ARGS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), password: process.env.OPENCODE_PASSWORD ?? null, pid: process.pid, threadVariables: Object.fromEntries(["PORTALS_THREAD", "CODEX_THREAD_ID", "CURSOR_CONVERSATION_ID"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) }));
}
if (process.env.OPENCODE_STANDIN_FAIL) {
  process.stderr.write("Error: the port is taken\n");
  process.exit(3);
}
if (process.env.OPENCODE_STANDIN_CHILD) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await new Promise((resolve) => child.once("message", resolve));
  writeFileSync(process.env.OPENCODE_STANDIN_CHILD, String(child.pid));
  child.disconnect();
}
function ready(): void {
  if (process.env.OPENCODE_STANDIN_READY) writeFileSync(process.env.OPENCODE_STANDIN_READY, String(process.pid));
}

if (process.env.OPENCODE_STANDIN_HANG_START) {
  process.on("SIGTERM", () => {});
  ready();
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const fake = await FakeOpenCode.start({ password: process.env.OPENCODE_PASSWORD ?? null });
ready();
process.stdout.write(`opencode server listening on ${fake.url}\n`);
process.on("SIGTERM", () => {
  if (process.env.OPENCODE_STANDIN_IGNORE_TERM) return;
  void fake.close().then(() => process.exit(0));
});
