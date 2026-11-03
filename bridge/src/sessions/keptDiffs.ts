import { appendFileSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { counters } from "../counters.ts";
import { log } from "../log.ts";
import type { StoredMessage } from "../providers/types.ts";
import { ensureDirectory, writeBytes } from "../store/jsonFile.ts";
import { cutDiff, turnDiffCap } from "./turnDiff.ts";

// The diffs of edits that an agent's history will not give back as they were (feature
// `turn_diff`), kept by the bridge as it saw them live. Claude Code's history keeps an
// edit's input and the text it answered, not the structured patch its live result had:
// an Edit rebuilt from its input has no line numbers and one replacement where
// `replace_all` made several, and a Write over a file shows what it wrote, not what it
// replaced, so a turn's counts after a restart of the bridge were not those shown live.
// The provider marks such a diff (`keepDiff` on its `tool.end`); the bridge keeps it under
// the tool call's id in `state/diffs/<thread>.jsonl`, and a thread loaded again (after a
// restart, or after its session was let go of) has it in place of the rebuilt one
// (`withKeptDiffs`): its tool rows, its turns' counts and their line numbers are as they
// were live. An edit the bridge did not see (made in a terminal while it was off) keeps
// the rebuilt one.
//
// One line an edit, appended a moment after it (`keepDelayMs`), never in the step that
// sends its event to the devices, and at once when the bridge stops. Each line starts
// with a line break rather than ends with one, so a line cut short by a crash is a line
// of its own, which costs only itself, as does any line that cannot be read; a file that
// cannot be read at all is no diffs. A diff past `turnDiffCap` is kept cut (`cutDiff`), its
// counts whole; a file past `diffsKeptBytes` is written again with only its latest lines,
// up to half of that, so the oldest edits go back to the rebuilt diffs first. A thread
// removed takes its file with it.

/** How long a diff kept waits in memory before it is written, with any others kept meanwhile. */
export const keepDelayMs = 1000;

/** How much a thread's file holds, in bytes, 2 MB: past it, only its latest lines, up to half of it, stay. */
export const diffsKeptBytes = 2 * 1024 * 1024;

/** One line of a thread's file. */
interface KeptLine {
  /** The tool call's id, as its stored row's `tool_call_id`. */
  id: string;
  diff: string;
}

export class DiffStore {
  private readonly folder: string;
  /** The lines kept but not yet written, by thread, oldest first. */
  private readonly pending = new Map<string, KeptLine[]>();
  private timer: NodeJS.Timeout | null = null;

  /** `folder`: `state/diffs`. */
  constructor(folder: string) {
    this.folder = folder;
  }

  /**
   * Keeps the diff an edit had live, for when the thread is loaded again: written a
   * moment later (`flush`), with any others kept meanwhile. A later diff under the same
   * id takes the place of the one before.
   */
  keep(thread: string, id: string, diff: string): void {
    if (id === "" || diff === "") return;
    const line = { id, diff: cutDiff(diff, turnDiffCap) };
    const waiting = this.pending.get(thread);
    if (waiting) waiting.push(line);
    else this.pending.set(thread, [line]);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, keepDelayMs);
    // Nothing waits for it: the bridge's close writes what is left.
    this.timer.unref();
  }

  /** Writes every diff kept and not yet written. A thread whose file cannot be written loses its diffs waiting, saying so. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending = [...this.pending];
    this.pending.clear();
    for (const [thread, lines] of pending) {
      try {
        this.append(thread, lines);
      } catch (error) {
        log.warn("could not keep the diffs of a thread's edits", { thread, error: (error as Error).message });
      }
    }
  }

  /** The diffs a thread keeps, by tool call id, those not yet written too; none when its file is missing or cannot be read. */
  read(thread: string): Map<string, string> {
    const kept = new Map<string, string>();
    for (const line of this.lines(thread)) kept.set(line.id, line.diff);
    for (const line of this.pending.get(thread) ?? []) kept.set(line.id, line.diff);
    return kept;
  }

  /**
   * Gives `to` the diffs `from` keeps, those not yet written too: a fork of it, whose
   * history is the agent's copy of `from`'s (Claude's keeps its tool call ids) and so
   * loses the same diffs. Written at once; a fork that cannot be written keeps none, saying so.
   */
  copy(from: string, to: string): void {
    const lines = [...this.read(from)].map(([id, diff]) => ({ id, diff }));
    if (lines.length === 0) return;
    try {
      this.append(to, lines);
    } catch (error) {
      log.warn("could not keep the diffs of a thread's edits for its fork", { thread: from, fork: to, error: (error as Error).message });
    }
  }

  /** Lets go of what a thread kept: it was removed. */
  forget(thread: string): void {
    this.pending.delete(thread);
    rmSync(this.file(thread), { force: true });
  }

  /**
   * Lets go of the files of threads taken off the list (`removed` says which were): one
   * the bridge stopped between taking off and letting go of its file. Not of every thread
   * the list does not have: a list that could not be read starts empty, and the threads
   * it had may yet be put back from the file kept aside.
   */
  sweep(removed: (thread: string) => boolean): void {
    let names: string[];
    try {
      names = readdirSync(this.folder);
    } catch {
      // None kept yet.
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      let thread: string;
      try {
        thread = decodeURIComponent(name.slice(0, -".jsonl".length));
      } catch {
        continue;
      }
      if (removed(thread) && !this.pending.has(thread)) rmSync(join(this.folder, name), { force: true });
    }
  }

  private append(thread: string, lines: KeptLine[]): void {
    const path = this.file(thread);
    ensureDirectory(this.folder);
    // Each line opens with its break: one cut short before it stays apart from it.
    appendFileSync(path, lines.map((line) => "\n" + JSON.stringify(line)).join(""), { mode: 0o600 });
    if (statSync(path).size > diffsKeptBytes) this.trim(thread);
  }

  /** The file again with only its latest lines, one for each id, up to half of `diffsKeptBytes`, the latest one at least. */
  private trim(thread: string): void {
    const latest = new Map<string, string>();
    for (const line of this.lines(thread)) {
      // Taken out and put back: the map's order is that of each id's latest line.
      latest.delete(line.id);
      latest.set(line.id, line.diff);
    }
    const kept: string[] = [];
    let room = diffsKeptBytes / 2;
    for (const [id, diff] of [...latest].reverse()) {
      const text = "\n" + JSON.stringify({ id, diff });
      // In bytes, as the file's size is: counted in characters, a diff in a script of
      // several bytes a character (Chinese, say) left the file past its cap, and every
      // edit after wrote it whole again.
      const bytes = Buffer.byteLength(text);
      if (bytes > room && kept.length > 0) break;
      kept.push(text);
      room -= bytes;
    }
    writeBytes(this.file(thread), () => Buffer.from(kept.reverse().join("")));
  }

  /** The lines of a thread's file that can be read, oldest first. */
  private lines(thread: string): KeptLine[] {
    const path = this.file(thread);
    const started = counters.on ? performance.now() : 0;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("could not read the diffs a thread kept", { thread, error: (error as Error).message });
      return [];
    }
    if (started) counters.read(path, Buffer.byteLength(text), performance.now() - started);
    const lines: KeptLine[] = [];
    for (const raw of text.split("\n")) {
      if (raw === "") continue;
      try {
        const line = JSON.parse(raw) as Partial<KeptLine> | null;
        if (typeof line?.id === "string" && line.id !== "" && typeof line.diff === "string" && line.diff !== "") lines.push({ id: line.id, diff: line.diff });
      } catch {
        // Cut short by a crash, or not the bridge's: only this line is lost.
      }
    }
    return lines;
  }

  private file(thread: string): string {
    return join(this.folder, `${encodeURIComponent(thread)}.jsonl`);
  }
}

/**
 * The stored conversation with the diff the bridge kept of each edit (`kept`, by tool
 * call id) in place of the one rebuilt from the agent's history: only on a row that says
 * the edit was made (its result has a diff), whose other keys stay as they are.
 */
export function withKeptDiffs(history: StoredMessage[], kept: ReadonlyMap<string, string>): StoredMessage[] {
  if (kept.size === 0) return history;
  for (const message of history) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    const diff = kept.get(message.tool_call_id);
    if (diff === undefined) continue;
    let result: unknown;
    try {
      result = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof (result as Record<string, unknown>).diff !== "string") continue;
    message.content = JSON.stringify({ ...(result as Record<string, unknown>), diff });
  }
  return history;
}
