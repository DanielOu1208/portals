import { spawn } from "node:child_process";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { endGroup, groupAlive } from "./child.ts";
import type { UpdateJob, UpdateRecord } from "./programs.ts";

// An update of an agent's program, in a process of its own (src/providers/programs.ts): it
// goes on through a restart of the host, and with it what holds it to its time limit. It runs
// the updater in a process group of its own and says how it stands in the update's record,
// which is the lock too: another update of that program waits until the record says this one
// ended. Past the time limit it ends the group; an update that failed has what it left ended
// too. Only then does the record say it is over, so that a retry cannot overlap it. One that
// worked leaves alone what it started: a service it restarted may be in its group.

/** How long what SIGKILL was sent to may take to go. */
const killedWithinMs = 2000;

const job = JSON.parse(process.argv[2] ?? "") as UpdateJob;
// From now: the time the updater itself has.
const deadlineAt = Date.now() + job.deadlineMs;

function say(fields: Partial<UpdateRecord>): void {
  record = { ...record, ...fields };
  const passing = `${job.record}.${process.pid}`;
  writeFileSync(passing, JSON.stringify(record), { mode: 0o600 });
  renameSync(passing, job.record);
}

let record: UpdateRecord = { startedAt: job.startedAt, deadlineAt, from: job.from, supervisor: process.pid };
const output = openSync(job.log, "w", 0o600);
const child = spawn(job.program, [...job.args], { cwd: job.cwd, stdio: ["ignore", output, output], detached: true });
closeSync(output);
say({ updater: child.pid });

let timedOut = false;
let failure: string | undefined;
let ending: Promise<void> | undefined;
const timer = setTimeout(() => {
  timedOut = true;
  if (child.pid !== undefined) ending = endGroup(child.pid);
}, Math.max(deadlineAt - Date.now(), 0));

const code = await new Promise<number | null>((resolve) => {
  child.once("error", (error) => {
    failure = `Could not run ${job.program}: ${error.message}`;
    resolve(null);
  });
  child.once("exit", resolve);
});
clearTimeout(timer);

if (child.pid !== undefined && (timedOut || code !== 0)) {
  await (ending ?? endGroup(child.pid));
  const end = Date.now() + killedWithinMs;
  while (groupAlive(child.pid) && Date.now() < end) await sleep(25);
}
say({ ended: { at: Date.now(), code, timedOut, ...(failure ? { failure } : {}) } });
process.exit(0);
