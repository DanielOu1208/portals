import { log } from "./log.ts";

// How the bridge's process ends (main.ts). SIGINT and SIGTERM stop it: the bridge
// closes, which stops every Claude, Pi and Cursor process it started, then the process
// exits. An exception nothing caught is logged and stops it the same way, so that none
// of those runs on without it, and the process exits 1; launchd starts it again. A
// promise that failed with nothing to catch it is logged with its stack, and the bridge
// goes on. A close that has not ended after eight seconds (an agent that does not close;
// a session that does not is given six, and the agents close after it all the same) is
// given up on, and the process exits all the same. An owned OpenCode server needs a
// native interrupt/idle confirmation before it stops, so its live owner may request
// sixteen seconds instead, still below the service manager's twenty-second stop.

/** How long a stop waits for the bridge to close. */
export const stopDeadlineMs = 8000;

interface Closable {
  close(): Promise<void>;
  readonly stopDeadlineMs?: number;
}

export interface Lifetime {
  /** The bridge has started: a stop closes it from now on (until then the process exits at once). */
  started(bridge: Closable): void;
}

/** Puts the process's policy in place; before the bridge starts. */
export function watchProcess(): Lifetime {
  let bridge: Closable | null = null;
  let stopping = false;
  let code = 0;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`stopping (${reason})`);
    if (bridge) {
      // Read before close: a fast provider may have already cleared its live owner.
      const deadlineMs = Math.min(16_000, Math.max(stopDeadlineMs, bridge.stopDeadlineMs ?? 0));
      const closed = bridge.close().then(
        () => true,
        (error) => {
          log.error("the bridge did not close cleanly", { error: stackOf(error) });
          return true;
        },
      );
      const late = new Promise<false>((resolve) => setTimeout(() => resolve(false), deadlineMs));
      if (!(await Promise.race([closed, late]))) log.warn(`the bridge had not closed after ${deadlineMs / 1000} seconds; it stops without waiting for the rest`);
    }
    process.exit(code);
  };
  // Kept while stopping, not `once`: a library that watches for signals (signal-exit,
  // which a dependency may load) sends the signal again when it sees no other
  // listener, which would end the process before the bridge has closed.
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("unhandledRejection", (reason) => log.error("a promise failed with nothing to catch it; the bridge goes on", { error: stackOf(reason) }));
  process.on("uncaughtException", (error) => {
    log.error("an error nothing caught; the bridge stops", { error: stackOf(error) });
    // Also when a stop is under way already: it ends the process as it would have, with 1.
    code = 1;
    void stop("an error nothing caught");
  });
  return {
    started: (running) => {
      bridge = running;
    },
  };
}

function stackOf(error: unknown): string {
  return (error as Error | undefined)?.stack ?? String(error);
}
