import { execFile } from "node:child_process";
import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { workingFolders } from "../pi/desk.ts";
import { droidSessionId } from "./desk.ts";

export interface DroidProcess { pid: number; command: string; args: string; argv?: string[]; cwd?: string }
export type OpenDroidSessions = { ids: Set<string>; folders: Set<string>; uncertain: boolean; desktop?: boolean };

/** Exec stays in its folder; an interactive TUI can /resume across project folders. */
export function openedDroids(processes: DroidProcess[], owned: ReadonlySet<number>): OpenDroidSessions {
  const result: OpenDroidSessions = { ids: new Set(), folders: new Set(), uncertain: false };
  for (const process of processes) {
    // On Linux a droid whose executable an update replaced runs on from "<path> (deleted)":
    // it is still a droid, and may have a session open.
    const command = process.command.replace(/ \(deleted\)$/, "");
    if (owned.has(process.pid) || basename(command) !== "droid") continue;
    const args = process.args.trim();
    const flags = args.startsWith(command) ? args.slice(command.length).trimStart() : args.replace(/^\S+\s*/, "");
    const argv = process.argv?.slice(1);
    const exec = argv ? argv[0] === "exec" : /^exec(?:\s|$)/.test(flags);
    if (argv ? argv[0] === "daemon" : /^daemon(?:\s|$)/.test(flags)) result.desktop = true;
    // --resume does not bind an interactive TUI for its lifetime: /resume can switch.
    if (!exec) { result.uncertain = true; continue; }
    const options = argv?.slice(0, argv.includes("--") ? argv.indexOf("--") : argv.length);
    const ids = options ? options.flatMap((arg, index) => {
      const flag = /^(?:--resume|--session-id|-r)(?:=(.*))?$/.exec(arg);
      const id = flag ? flag[1] ?? options[index + 1] : undefined;
      return id && droidSessionId.test(id) ? [id] : [];
    }) : [...flags.matchAll(/(?:--resume|--session-id|-r)(?:=|\s+)([0-9a-f-]{36})(?=\s|$)/gi)].map((match) => match[1]).filter((id) => droidSessionId.test(id));
    for (const id of ids) result.ids.add(id);
    // ps flattens argv: any apparent flag may be prompt text. Keep the folder too.
    if (!argv || ids.length === 0) {
      if (process.cwd) result.folders.add(process.cwd);
      else result.uncertain = true;
    }
  }
  return result;
}

/** Runs a program for its output; one that fails rejects with its exit status as `code`. */
type Run = (program: string, args: string[]) => Promise<string>;

function output(program: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(program, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error && !(basename(program) === "lsof" && error.code === 1)) reject(Object.assign(new Error("Portals could not inspect running Droid processes."), { code: error.code }));
    else resolve(stdout);
  }));
}

export async function droidProcesses(): Promise<DroidProcess[]> {
  if (process.platform === "linux") {
    const ids = (await readdir("/proc")).filter((id) => /^\d+$/.test(id));
    const result: DroidProcess[] = [];
    for (const id of ids) {
      try {
        if ((await readFile(`/proc/${id}/comm`, "utf8")).trim() !== "droid") continue;
        const command = await readlink(`/proc/${id}/exe`).catch(() => "droid");
        const argv = (await readFile(`/proc/${id}/cmdline`, "utf8")).split("\0");
        if (argv.at(-1) === "") argv.pop();
        const cwd = await readlink(`/proc/${id}/cwd`).catch(() => undefined);
        result.push({ pid: Number(id), command, args: argv.join(" "), argv, cwd });
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        // Permission denied must not be mistaken for an absent process.
        throw new Error("Portals could not inspect running Droid processes.");
      }
    }
    return result;
  }
  return listedDroids();
}

/** The droids `ps` lists (macOS), with their arguments and folders. */
export async function listedDroids(run: Run = output): Promise<DroidProcess[]> {
  const all = await run("/bin/ps", ["-axo", "pid=,comm="]);
  const droids = all.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && basename(match[2]) === "droid" ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
  if (droids.length === 0) return [];
  const folders = workingFolders(await run("/usr/sbin/lsof", ["-a", "-p", droids.map((entry) => entry.pid).join(","), "-d", "cwd", "-Fpn"]));
  const listed = await Promise.all(droids.map(async (entry): Promise<DroidProcess[]> => {
    let args: string;
    try { args = await run("/bin/ps", ["-p", String(entry.pid), "-o", "args="]); } catch (error) {
      // ps says no such process (exit status 1): it exited since it was listed (a short
      // `droid exec`), so it has nothing open. Any other failure is a check not made.
      if ((error as { code?: unknown }).code === 1) return [];
      throw error;
    }
    return [{ ...entry, args, cwd: folders.get(entry.pid) ? await realpath(folders.get(entry.pid)!).catch(() => folders.get(entry.pid)) : undefined }];
  }));
  return listed.flat();
}
