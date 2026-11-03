import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import WebSocket from "ws";

// A stand-in for `codex app-server` run as the bridge's own child process (codex.mode
// "own"), for test/codex-own.test.ts: it passes each line of its standard input to the
// stand-in daemon (test/codex-daemon.ts) as a frame, and each frame back as a line, so
// the one daemon plays Codex on both ways in.
//
//   node test/codex-standin.ts <daemon's socket> <file for its process id> app-server
//
// It ends when its input ends or the daemon hangs up.

const [socketPath, pidFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));

const socket = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false });
const early: string[] = [];
socket.on("open", () => {
  for (const line of early.splice(0)) socket.send(line);
});
socket.on("message", (data) => process.stdout.write(`${data.toString()}\n`));
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(1));

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(line);
  else early.push(line);
});
input.on("close", () => socket.close());
