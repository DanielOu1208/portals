// One line per message on standard error, with a time and a level. Never pass a
// password, cookie, ticket or token to these.

const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof levels;

function threshold(): number {
  const wanted = (process.env.PORTALS_BRIDGE_LOG ?? process.env.AERIPORTAL_BRIDGE_LOG) as Level | undefined;
  return wanted && wanted in levels ? levels[wanted] : levels.info;
}

let minimum = threshold();

/** Told the bytes of each line written, while the counters are on (counters.ts). */
let tally: ((bytes: number) => void) | null = null;

/** Who is told of each line written; null for nobody. */
export function tallyLog(to: ((bytes: number) => void) | null): void {
  tally = to;
}

/** Changes how much is logged; tests turn it off. */
export function setLogLevel(level: Level): void {
  minimum = levels[level];
}

function write(level: Exclude<Level, "silent">, message: string, fields?: Record<string, unknown>): void {
  if (levels[level] < minimum) return;
  const extra = fields ? " " + JSON.stringify(fields) : "";
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}${extra}\n`;
  if (tally) tally(Buffer.byteLength(line));
  // Written at once to the log file the LaunchAgent gives it, which throws when the disk is
  // full: the line is lost, the bridge stays (2026-10-27, MBP16 full: three stops in half a
  // minute, each cutting the turns under way, the throw also from the line that said so).
  try { process.stderr.write(line); } catch { /* no room for the line */ }
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
