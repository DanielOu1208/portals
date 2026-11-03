import { execFile } from "node:child_process";
import { counters } from "../../counters.ts";
import { log } from "../../log.ts";
import { readJSON, writeJSON } from "../../store/jsonFile.ts";
import { endGroup } from "../child.ts";
import { cursorName } from "./options.ts";

// Cursor's processes, noted in a file while they run, so that a bridge can end what an
// earlier one left behind.
//
// A bridge that is stopped ends its Cursor processes. One that is killed, crashes or
// loses power cannot, and Cursor does not end by itself when its input closes in the
// middle of a turn: it goes on with the turn, editing files and running commands with
// nobody shown any of it, and stays (seen on 2026-10-12, alive three minutes after the
// bridge was killed). So each process is noted when it starts and struck when it ends,
// and a bridge that starts ends the ones still noted before it starts any of its own.
//
// A note is a process id, which the system gives to another process in time. One is
// ended only when the process of that id started at the moment the note says, and its
// parent is no longer the bridge that noted it: a bridge started by mistake beside a
// running one, on the same folder, leaves that one's Cursor alone.

interface Note {
  pid: number;
  /** When it was started, in milliseconds. */
  at: number;
  /** The bridge that started it. */
  bridge: number;
}

/** How far a process's start as the system tells it (in whole seconds) may be from the note's. */
const sameStartMs = 5000;

function isNote(value: any): value is Note {
  // Never 0 or 1: a signal to such a "group" would go to every process there is.
  return Number.isSafeInteger(value?.pid) && value.pid > 1 && typeof value.at === "number" && Number.isSafeInteger(value.bridge);
}

/** The parent of the process `pid` and when it started; null when there is none. */
function processOf(pid: number): Promise<{ parent: number; started: number } | null> {
  return new Promise((resolve) => {
    if (counters.on) counters.spawned("ps");
    // "  501 Mon Oct 12 05:41:02 2026", in the system's own words whatever the user's language,
    // and in UTC: the system and Node each have their own time zone rules, which can differ.
    execFile("/bin/ps", ["-o", "ppid=,lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 5000 }, (error, stdout) => {
      const match = error ? null : /^\s*(\d+)\s+(\S.*?)\s*$/.exec(stdout);
      const started = match ? Date.parse(`${match[2]} UTC`) : Number.NaN;
      resolve(match && !Number.isNaN(started) ? { parent: Number(match[1]), started } : null);
    });
  });
}

export class ProcessNotes {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Notes a process this bridge just started. */
  add(pid: number): void {
    this.write([...this.read().filter((note) => note.pid !== pid), { pid, at: Date.now(), bridge: process.pid }]);
  }

  /** Strikes a process that has ended. */
  remove(pid: number): void {
    const notes = this.read();
    if (notes.some((note) => note.pid === pid)) this.write(notes.filter((note) => note.pid !== pid));
  }

  /**
   * Ends every noted process whose bridge is gone, with what it started, and strikes
   * the notes of those and of processes that are no more. Resolves when they are gone.
   */
  async endLeftovers(): Promise<void> {
    const notes = this.read();
    if (notes.length === 0) return;
    const kept = await Promise.all(
      notes.map(async (note) => {
        const found = await processOf(note.pid);
        // Gone, or the id is another process's by now.
        if (!found || Math.abs(found.started - note.at) > sameStartMs) return [];
        // Its bridge still runs: not this one's to end.
        if (found.parent === note.bridge) return [note];
        log.warn(`${cursorName} was left running by a bridge that did not stop it; stopping it`, { pid: note.pid });
        await endGroup(note.pid);
        return [];
      }),
    );
    // Those noted meanwhile stay; only the ones looked at are struck.
    const looked = new Set(notes.map((note) => note.pid));
    this.write([...kept.flat(), ...this.read().filter((note) => !looked.has(note.pid))]);
  }

  private read(): Note[] {
    const notes = readJSON<unknown>(this.file, []);
    return Array.isArray(notes) ? notes.filter(isNote) : [];
  }

  private write(notes: Note[]): void {
    try {
      writeJSON(this.file, notes);
    } catch (error) {
      log.warn(`could not note ${cursorName}'s processes`, { error: (error as Error).message });
    }
  }
}
