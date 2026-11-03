// Counts the bytes between the app and a scratch bridge, for scripts/return-bench.sh: a
// plain TCP relay from 127.0.0.1:<listen> to 127.0.0.1:<target>, which appends
//
//     <seconds since 1970> <bytes up so far> <bytes down so far>
//
// to <file> each tenth of a second in which anything passed. Up is the app's, down the
// bridge's. Only ports of the return bench (9364 → 9354) are taken. With RETURN_DELAY_MS
// set, each piece is passed on that much later each way, as over a slower link (50 ms
// each way is about a phone on a mobile network reaching the Mac through Tailscale); the
// delay can be changed while it runs by writing a number of milliseconds to <file>.delay.
//
//   node scripts/return-bench/proxy.mjs <listen> <target> <file>

import { lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createConnection, createServer } from "node:net";

const [listen, target, file] = process.argv.slice(2);
if (listen !== "9364" || target !== "9354" || !file) {
  console.error("usage: proxy.mjs 9364 9354 <file>");
  process.exit(2);
}
// A file of its own, made anew: one left from an earlier run is taken away first (a link
// there is taken away, never followed), then the file is made only if nothing is there
// (`wx`), and written through the handle that made it.
try {
  lstatSync(file);
  unlinkSync(file);
} catch {}
const log = openSync(file, "wx");
let delay = Number(process.env.RETURN_DELAY_MS ?? 0);
setInterval(() => {
  try {
    const wanted = Number(readFileSync(`${file}.delay`, "utf8").trim());
    if (Number.isFinite(wanted) && wanted >= 0) delay = wanted;
  } catch {}
}, 500);
let up = 0;
let down = 0;
let written = { up: 0, down: 0 };
setInterval(() => {
  if (up === written.up && down === written.down) return;
  written = { up, down };
  writeSync(log, `${(Date.now() / 1000).toFixed(3)} ${up} ${down}\n`);
}, 100);

// Each direction owns its queue: reducing the delay cannot overtake older bytes,
// and a graceful FIN follows the bytes rather than discarding their pending timer.
function forward(source, destination, count) {
  let queue = [];
  let timer;
  let stopped = false;
  const drain = () => {
    timer = undefined;
    while (queue.length) {
      const wait = queue[0].at - Date.now();
      if (wait > 0) {
        timer = setTimeout(drain, wait);
        return;
      }
      const { chunk } = queue.shift();
      if (chunk === null) destination.end();
      else destination.write(chunk);
    }
  };
  const enqueue = (chunk) => {
    if (stopped) return;
    queue.push({ chunk, at: Date.now() + (delay > 0 ? delay : 0) });
    if (timer === undefined) drain();
  };
  source.on("data", (chunk) => {
    count(chunk.length);
    enqueue(chunk);
  });
  source.on("end", () => enqueue(null));
  return () => {
    stopped = true;
    clearTimeout(timer);
    queue = [];
  };
}

createServer({ allowHalfOpen: true }, (app) => {
  const bridge = createConnection({ host: "127.0.0.1", port: Number(target), allowHalfOpen: true });
  const cancel = [
    forward(app, bridge, (bytes) => { up += bytes; }),
    forward(bridge, app, (bytes) => { down += bytes; }),
  ];
  const abort = () => {
    for (const stop of cancel) stop();
    app.destroy();
    bridge.destroy();
  };
  for (const socket of [app, bridge]) {
    socket.on("close", (hadError) => {
      // Both halves may finish while bytes already read from this socket still
      // await their delay on the other one. Only an interrupted close cancels them.
      if (hadError || !socket.readableEnded || !socket.writableFinished) abort();
    });
  }
  app.on("error", abort);
  bridge.on("error", abort);
}).listen(Number(listen), "127.0.0.1");
