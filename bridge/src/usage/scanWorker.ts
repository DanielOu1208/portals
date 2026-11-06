import { parentPort, workerData } from "node:worker_threads";
import { Scanner, type Cursor, type ScanMessage } from "./scanner.ts";

// The worker thread the history is read in (book.ts starts it): the host's loop never
// waits on a read, and whatever goes wrong here ends this thread at worst, never the host.
// It is told the cursors once, when it starts, and `{ type: "scan" }` each time; it
// answers with the scanner's messages, the last of each scan `done`.

interface Data {
  home: string;
  env: NodeJS.ProcessEnv;
  cursors: Record<string, Cursor>;
  avoid?: Record<string, number>;
}

const data = workerData as Data;
const scanner = new Scanner({ home: data.home, env: data.env, cursors: data.cursors, avoid: data.avoid });
const post = (message: ScanMessage) => parentPort?.postMessage(message);
let running = false;

parentPort?.on("message", (message: { type?: string }) => {
  if (message?.type !== "scan" || running) return;
  running = true;
  scanner
    .scan(post)
    .catch((error: unknown) => {
      post({ type: "log", level: "error", message: "usage: a scan of history stopped", fields: { why: (error as Error)?.message } });
      post({ type: "done", files: 0, read: 0, bytes: 0, ms: 0 });
    })
    .finally(() => {
      running = false;
    });
});
