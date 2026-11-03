import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A program that ignores SIGTERM, for the tests of what the bridge runs with a timeout and
// kills with SIGKILL (a version check, `claude agents`, `codex app-server daemon start`).
//
// It is a shell, which sets its trap and then writes its process id, and becomes `sleep`,
// which keeps that id and goes on ignoring SIGTERM. It sleeps longer than any test waits
// for its end (`deafLifetimeS`), so that an end a test sees is never its own.
//
// A Mac busy with the whole suite and a build may take longer than the timeout to start a
// shell, which is then killed before it set its trap: a SIGTERM would have ended it too, so
// that run shows nothing about one that ignores SIGTERM. `deafRuns` runs the check again with twice the timeout until the program
// was deaf before its end, so that what the check sees is always such a program's end,
// however long the shell took to start; on a Mac at rest the first run is it.

/**
 * How long a deaf program lives if nothing kills it: beyond the longest wait for its end,
 * three times the last timeout `deafRuns` tries (32 s from 1 s: 96 s).
 */
export const deafLifetimeS = 300;

export interface DeafProgram {
  path: string;
  /** Where it writes its process id once it ignores SIGTERM. */
  pidFile: string;
}

/** Writes a program at `name` (in `folder`) that ignores SIGTERM. */
export function deafProgram(folder: string, name: string): DeafProgram {
  const path = join(folder, name);
  const pidFile = join(folder, `${name}.pid`);
  writeFileSync(path, `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nexec sleep ${deafLifetimeS}\n`);
  chmodSync(path, 0o755);
  return { path, pidFile };
}

/**
 * The process id `program` wrote, which says that it ignores SIGTERM; null while it has
 * not, and when it was ended before then. `echo` writes the id and its line's end at once,
 * so a whole line is a whole id (a shell killed as it opened the file leaves it empty, and
 * a pid of 0 would be this process's group).
 */
export function deafPid(program: DeafProgram): number | null {
  const said = existsSync(program.pidFile) ? readFileSync(program.pidFile, "utf8") : "";
  return /^[1-9]\d*\n$/.test(said) ? Number(said) : null;
}

/**
 * Runs `check` on a program of its own that ignores SIGTERM, with the timeout
 * `firstTimeoutMs`, and again with twice the timeout while the program was ended before
 * it ignored SIGTERM, `tries` times at most. `check` resolves once the program's run is
 * over (or once it is clear that it is not). What `check` gave, with the program's id, of
 * the first run whose program was deaf; of the last run when none was, its id null.
 * `started` is told each program, for a test to end any left running.
 */
export async function deafRuns<T>(
  folder: string,
  name: string,
  firstTimeoutMs: number,
  check: (program: DeafProgram, timeoutMs: number) => Promise<T>,
  started: (program: DeafProgram) => void = () => {},
  tries = 6,
): Promise<{ result: T; pid: number | null; timeoutMs: number }> {
  if (3 * firstTimeoutMs * 2 ** (tries - 1) >= deafLifetimeS * 1000) throw new Error("a deaf program would end by itself before its last wait");
  for (let tried = 1, timeoutMs = firstTimeoutMs; ; tried += 1, timeoutMs *= 2) {
    const program = deafProgram(folder, `${name}-${tried}`);
    started(program);
    const result = await check(program, timeoutMs);
    const pid = deafPid(program);
    if (pid !== null || tried === tries) return { result, pid, timeoutMs };
  }
}
