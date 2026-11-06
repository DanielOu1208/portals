import { Scanner, type Cursor, type ScanMessage } from "./scanner.ts";

// The process the history is read in (book.ts forks it, one for each scan): the host's
// loop never waits on a read, whatever goes wrong here ends this process at worst, never
// the host, and all the memory a read took goes back to the system when it ends. A worker
// thread would leave it behind: zstd's and the reads' freed native memory stays in the
// host's own malloc zone, a hundred MB and more after a first read of a year of history.
// It is told `{ type: "scan" }` with the cursors, and answers with the scanner's messages,
// the last of the scan `done`; its owner ends it then.

interface Scan {
  type: "scan";
  home: string;
  env: NodeJS.ProcessEnv;
  cursors: Record<string, Cursor>;
  avoid?: Record<string, number>;
}

const post = (message: ScanMessage) => process.send?.(message);
let running = false;

process.on("message", (message: Partial<Scan>) => {
  if (message?.type !== "scan" || running) return;
  running = true;
  const data = message as Scan;
  Promise.resolve()
    .then(() => new Scanner({ home: data.home, env: data.env, cursors: data.cursors, avoid: data.avoid }).scan(post))
    .catch((error: unknown) => {
      post({ type: "log", level: "error", message: "usage: a scan of history stopped", fields: { why: (error as Error)?.message } });
      post({ type: "done", files: 0, read: 0, bytes: 0, ms: 0 });
    })
    .finally(() => {
      running = false;
    });
});

// The host went (stopped, or ended without stopping the book): nothing is left to tell.
process.on("disconnect", () => process.exit(0));
