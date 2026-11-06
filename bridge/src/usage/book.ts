import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { log } from "../log.ts";
import type { ReadRequest, Source } from "./readers/common.ts";
import { readAgents, Scanner, type ScanMessage } from "./scanner.ts";
import { UsageStore } from "./store.ts";
import type { DayRow, HourRow, ScanState, UsageAgent, UsageBook, UsageVia } from "./types.ts";

// The book of usage (types.ts `UsageBook`): what all coding on this computer spent, read
// from the agents' history (scanner.ts) and kept as daily totals (store.ts). Read at
// start, every 10 minutes, and a few seconds after `poke` (a turn ended); never two reads
// at once. The reading runs in a worker thread (scanWorker.ts), or in this thread when
// `inProcess` (tests).
//
// Nothing here may stop the host, or keep it from stopping, whatever goes wrong (the
// rule at the top of counters.ts): every timer's and message's work is one `try`, every
// promise is caught, the worker does not keep the process alive, and a worker that ends
// or errs is started again later, with the cursors this side has, so the host goes on
// without the numbers rather than not at all.

/**
 * Whether a request went through Portals: the host's own record of the sessions it ran
 * (sessions.ts), from when it ran each. `originator` is Codex's `session_meta.originator`.
 */
export type ViaResolver = (agent: UsageAgent, session: string, at: number, originator?: string) => UsageVia;

/** Codex's originators for a session Portals started: always Portals', whatever the record says. */
export const portalsOriginators: ReadonlySet<string> = new Set(["portals-bridge", "aeriportal-bridge"]);

export interface UsageBookOptions {
  /** The host's state folder; the book keeps `usage/` in it. */
  stateDir: string;
  /** The home the agents keep their history under. */
  home: string;
  /** The host's environment: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, ... */
  env: NodeJS.ProcessEnv;
  via: ViaResolver;
  clock?: () => number;
  /** Reads in this thread instead of a worker: for tests. */
  inProcess?: boolean;
  /** Where to read, in this thread only (tests); every agent's otherwise. */
  sources?: Source[];
  /** The host's time zone; the system's when not given. */
  timeZone?: string;
  /** How often a scan runs on its own (10 minutes). */
  everyMs?: number;
  /** How long after `poke` the scan runs, so a burst of turns ending is one scan (5 seconds). */
  pokeMs?: number;
  /** How often the totals are written at most (2 minutes). */
  saveEveryMs?: number;
  /** How long after a worker ended a new one may start (1 minute, doubled each time up to the scan interval). */
  restartMs?: number;
  /** How long a scan may run before its worker is ended (30 minutes). */
  longestScanMs?: number;
  /** The worker's module, scanWorker's by default: a test gives one that fails. */
  worker?: URL;
}

/** The running book, with what the wire needs beside the totals. */
export interface RunningUsageBook extends UsageBook {
  /** The time zone the days are in, for the wire's `time_zone`. */
  readonly timeZone: string;
  /** The agents whose history is read, for the wire's `agents`. */
  readonly agents: UsageAgent[];
  /** Settles when the scan under way, or else the next one, ends. */
  scanned(): Promise<void>;
}

const workerUrl = new URL(import.meta.url.endsWith(".ts") ? "./scanWorker.ts" : "./scanWorker.js", import.meta.url);

/** Starts the book: loads what was saved and reads what is new. */
export function startUsageBook(options: UsageBookOptions): RunningUsageBook {
  const clock = options.clock ?? Date.now;
  const everyMs = options.everyMs ?? 10 * 60_000;
  const pokeMs = options.pokeMs ?? 5_000;
  const saveEveryMs = options.saveEveryMs ?? 2 * 60_000;
  const firstRestartMs = options.restartMs ?? 60_000;
  const longestScanMs = options.longestScanMs ?? 30 * 60_000;
  const store = new UsageStore(join(options.stateDir, "usage"), { timeZone: options.timeZone });
  try {
    store.load();
  } catch (error) {
    log.warn("usage: the saved totals could not be loaded", { why: (error as Error).message });
  }
  const sourceEnv = pickEnv(options.env);

  let stopped = false;
  let running = false;
  let again = false;
  let first = store.scannedAt === undefined;
  let progress: number | undefined;
  let savedAt = 0;
  let saveTimer: NodeJS.Timeout | undefined;
  let pokeTimer: NodeJS.Timeout | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let worker: Worker | undefined;
  let restartMs = firstRestartMs;
  let notBefore = 0;
  let endScan: (() => void) | undefined;
  let waiters: (() => void)[] = [];
  let scanner: Scanner | undefined;
  /** The file the worker is reading, and files a worker ended while reading, by size. */
  let reading: { path: string; size: number } | undefined;
  const avoid: Record<string, number> = {};

  const via = (request: ReadRequest): UsageVia => {
    if (request.originator !== undefined && portalsOriginators.has(request.originator)) return "portals";
    try {
      return options.via(request.agent, request.session, request.at, request.originator) === "portals" ? "portals" : "elsewhere";
    } catch {
      return "elsewhere";
    }
  };

  const save = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!store.dirty) return;
    try {
      store.save();
      savedAt = clock();
    } catch (error) {
      log.warn("usage: the totals could not be saved; they are tried again later", { why: (error as Error).message });
    }
  };

  /** Saves now if the last save was long enough ago, else once it is. */
  const saveSoon = () => {
    if (stopped || !store.dirty || saveTimer) return;
    const wait = savedAt + saveEveryMs - clock();
    if (wait <= 0) save();
    else saveTimer = setTimeout(save, wait).unref();
  };

  const handle = (message: ScanMessage) => {
    if (stopped) return;
    try {
      if (message.type === "reading") {
        reading = { path: message.path, size: message.size };
      } else if (message.type === "progress") {
        progress = message.total > 0 ? Math.min(1, message.done / message.total) : 1;
      } else if (message.type === "log") {
        log[message.level](message.message, message.fields);
      } else if (message.type === "done") {
        if (first) log.info("usage: history read", { files: message.files, read: message.read, bytes: message.bytes, ms: message.ms });
      } else {
        store.apply(message, via);
        saveSoon();
      }
    } catch (error) {
      log.warn("usage: a scan's message could not be used", { type: message.type, why: (error as Error).message });
    }
  };

  const startWorker = (): Worker | undefined => {
    if (worker) return worker;
    if (clock() < notBefore) return undefined;
    try {
      const started = new Worker(options.worker ?? workerUrl, {
        workerData: { home: options.home, env: sourceEnv, cursors: store.cursors(), avoid },
        execArgv: [],
        // Its own heap, small: a worker that needs more ends, and the host does not.
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 },
      });
      started.unref();
      started.on("message", (message: ScanMessage) => {
        handle(message);
        if (message.type === "done" && started === worker) endScan?.();
      });
      started.on("error", (error) => log.warn("usage: the history reader stopped", { why: error.message }));
      started.on("exit", (code) => {
        if (started !== worker) return;
        worker = undefined;
        if (!stopped && code !== 0) {
          // Ended while reading a file: the next worker leaves that file until it changes.
          if (reading) avoid[reading.path] = reading.size;
          log.warn("usage: the history reader ended; it is started again later", { code });
        }
        reading = undefined;
        notBefore = clock() + restartMs;
        restartMs = Math.min(restartMs * 2, everyMs);
        endScan?.();
      });
      worker = started;
      return started;
    } catch (error) {
      notBefore = clock() + restartMs;
      log.warn("usage: the history reader could not start", { why: (error as Error).message });
      return undefined;
    }
  };

  const scanOnce = async (): Promise<void> => {
    if (options.inProcess) {
      scanner ??= new Scanner({ home: options.home, env: sourceEnv, cursors: store.cursors(), sources: options.sources, now: clock });
      await scanner.scan(handle);
      return;
    }
    const reader = startWorker();
    if (!reader) {
      // Not yet: a worker ended a moment ago. Read once it may start again.
      if (!restartTimer && !stopped) {
        restartTimer = setTimeout(() => {
          restartTimer = undefined;
          run();
        }, Math.max(0, notBefore - clock())).unref();
      }
      return;
    }
    await new Promise<void>((resolve) => {
      const watchdog = setTimeout(() => {
        log.warn("usage: a scan of history took too long; its reader is ended", { minutes: Math.round(longestScanMs / 60_000) });
        void reader.terminate().catch(() => undefined);
      }, longestScanMs).unref();
      endScan = () => {
        clearTimeout(watchdog);
        endScan = undefined;
        resolve();
      };
      reader.postMessage({ type: "scan" });
    });
  };

  const run = (): void => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    progress = 0;
    scanOnce()
      .catch((error: unknown) => log.warn("usage: a scan of history stopped", { why: (error as Error)?.message }))
      .then(() => {
        running = false;
        if (stopped) return;
        if (worker || options.inProcess) {
          store.scannedAt = clock();
          store.dirty = true;
          first = false;
          restartMs = firstRestartMs;
        }
        progress = undefined;
        saveSoon();
        const settled = waiters;
        waiters = [];
        for (const resolve of settled) resolve();
        if (again) {
          again = false;
          run();
        }
      })
      .catch(() => undefined);
  };

  const every = setInterval(run, everyMs);
  every.unref();
  // Not unref'd: an unref'd immediate in a loop with nothing else to do never runs, and
  // this one only starts the first scan (whose worker does not keep the process alive).
  setImmediate(run);

  return {
    timeZone: store.calendar.timeZone,
    agents: readAgents,
    days(from: string, to: string): DayRow[] {
      return store.dayRows(from, to);
    },
    hours(from: string, to: string): HourRow[] {
      return store.hourRowsBetween(from, to);
    },
    scan(): ScanState {
      const state: ScanState = { scanning: running && first };
      if (running && progress !== undefined) state.progress = progress;
      if (store.scannedAt !== undefined) state.scannedAt = store.scannedAt;
      return state;
    },
    poke(): void {
      if (stopped || pokeTimer) return;
      pokeTimer = setTimeout(() => {
        pokeTimer = undefined;
        run();
      }, pokeMs);
      pokeTimer.unref();
    },
    scanned(): Promise<void> {
      return new Promise((resolve) => {
        if (stopped) resolve();
        else waiters.push(resolve);
      });
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(every);
      for (const timer of [pokeTimer, restartTimer, saveTimer]) if (timer) clearTimeout(timer);
      saveTimer = undefined;
      const ending = worker;
      worker = undefined;
      endScan?.();
      if (ending) {
        try {
          await Promise.race([ending.terminate(), new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
        } catch {
          // Ended already.
        }
      }
      save();
      for (const resolve of waiters) resolve();
      waiters = [];
    },
  };
}

/** The part of the environment that says where history is, so the worker is given no more. */
function pickEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "FACTORY_HOME_OVERRIDE"]) {
    if (env[key] !== undefined) picked[key] = env[key];
  }
  return picked;
}
