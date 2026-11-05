import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { endGroup, groupAlive, processOf } from "./child.ts";
import { claim, saveJob, type UpdateJob, type UpdateRecord } from "./programUpdateLock.ts";

// An update of an agent's program, in a process of its own (src/providers/programs.ts), which
// owns the update's record (src/providers/programUpdateLock.ts) and holds it to its time limit,
// through a restart of the host too.
//
// The updater starts behind a gate: a shell in a process group of its own, waiting on a pipe
// from here. The record names it, then the gate opens. Should this process stop before that,
// whatever stopped it, the pipe closes and the shell ends with nothing run. So nothing of an
// update runs that its record does not name.
//
// Past the time limit this process ends the group; an update that failed has what it left ended
// too. Only then does the record say it is over, so that a retry cannot overlap it. One that
// worked leaves alone what it started: a service it restarted may be in its group.

/** How long what SIGKILL was sent to may take to go. */
const killedWithinMs = 2000;

const gate = `IFS= read -r go || exit 125; exec "$@"`;

const job = JSON.parse(process.argv[2] ?? "") as UpdateJob;
if (Date.now() > job.startBy) process.exit(0);

const supervisor = processOf(process.pid);
if (!supervisor) process.exit(1);

let record: UpdateRecord | null = claim(job.folder, job.id, (id) => ({ id, startedAt: job.startedAt, deadlineAt: Date.now() + job.deadlineMs, from: job.from, supervisor }));
if (!record) process.exit(0);
const say = (fields: Partial<UpdateRecord>) => {
  record = { ...record!, ...fields };
  saveJob(job.folder, job.id, record);
};

const output = openSync(job.log, "w", 0o600);
const child = spawn("/bin/sh", ["-c", gate, "sh", job.program, ...job.args], { cwd: job.cwd, stdio: ["pipe", output, output], detached: true });
closeSync(output);
child.stdin?.on("error", () => undefined);
const updater = child.pid === undefined ? null : processOf(child.pid);
if (!updater) process.exit(1);
say({ updater });
child.stdin?.end("go\n");

let timedOut = false;
let ending: Promise<void> | undefined;
const timer = setTimeout(() => {
  timedOut = true;
  ending = endGroup(updater.pid);
}, job.deadlineMs);

const code = await new Promise<number | null>((resolve) => {
  child.once("error", () => resolve(null));
  child.once("exit", resolve);
});
clearTimeout(timer);

if (timedOut || code !== 0) {
  await (ending ?? endGroup(updater.pid));
  const end = Date.now() + killedWithinMs;
  while (groupAlive(updater.pid) && Date.now() < end) await sleep(25);
}
say({ ended: { at: Date.now(), code, timedOut } });
process.exit(0);
