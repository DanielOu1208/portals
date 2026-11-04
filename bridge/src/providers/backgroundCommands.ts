import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { asShown, outputTail } from "./liveOutput.ts";
import type { ProviderEvent, SubagentInfo, SubagentStatus } from "./types.ts";

// The commands an agent left running in the background after its turn moved on (Claude
// Code's `run_in_background`, Codex's background terminals, Droid's background commands),
// each a row of the subagents line (feature background_commands): what it runs, its last
// line of output while it runs, its output's end when opened, how it ended, and a Stop
// where the agent has one. Its output goes out at most once a second per command, the
// whole tail each time (`subagent.progress` replaces the one before, and the session's
// replay log keeps only a command's latest). Nothing of it is written to the thread's
// history.

/** The least time between two updates of one command's row. */
const intervalMs = 1000;
/** How often an output file is read again while its command runs. */
const pollMs = 1000;

interface Command {
  info: SubagentInfo;
  text: string;
  dropped: boolean;
  sentAt?: number;
  timer?: NodeJS.Timeout;
  file?: { path: string; timer?: NodeJS.Timeout; reading: boolean };
}

export interface BackgroundCommandsOptions {
  now?: () => number;
  intervalMs?: number;
  pollMs?: number;
}

export class BackgroundCommands {
  private readonly commands = new Map<string, Command>();
  private readonly emit: (event: ProviderEvent) => void;
  private readonly now: () => number;
  private readonly interval: number;
  private readonly poll: number;

  constructor(emit: (event: ProviderEvent) => void, options: BackgroundCommandsOptions = {}) {
    this.emit = emit;
    this.now = options.now ?? Date.now;
    this.interval = options.intervalMs ?? intervalMs;
    this.poll = options.pollMs ?? pollMs;
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  /** Whether `id` is one of these and still runs. */
  running(id: string): boolean {
    return this.commands.get(id)?.info.status === "running";
  }

  /** A command went on in the background: its row, at work, with what it printed so far. */
  start(id: string, command: { goal: string; startedAt?: number; stoppable: boolean; output?: string; outputTruncated?: boolean }): void {
    const known = this.commands.get(id);
    if (known?.info.status === "running") return;
    if (known) this.forget(id);
    const info: SubagentInfo = {
      id, kind: "command", goal: oneLine(command.goal).slice(0, 500), status: "running",
      startedAt: command.startedAt ?? this.now(), background: true, stoppable: command.stoppable,
    };
    const entry: Command = { info, text: "", dropped: false };
    this.commands.set(id, entry);
    if (command.output) this.take(entry, command.output, command.outputTruncated === true);
    this.send(entry);
    // Ended ones are kept a while for a late word on them, but not without end.
    if (this.commands.size > 64) {
      for (const [other, kept] of this.commands) {
        if (this.commands.size <= 64) break;
        if (kept.info.status !== "running") this.forget(other);
      }
    }
  }

  /** Whether command `id`, still running, can be stopped by itself: its row says so again when that changed. */
  stoppable(id: string, stoppable: boolean): void {
    const entry = this.commands.get(id);
    if (!entry || entry.info.status !== "running" || entry.info.stoppable === stoppable) return;
    entry.info.stoppable = stoppable;
    this.send(entry);
  }

  /** More output of command `id`, following what came before. */
  append(id: string, chunk: string): void {
    const entry = this.commands.get(id);
    if (!entry || entry.info.status !== "running" || chunk === "") return;
    this.take(entry, entry.text + chunk, entry.dropped);
    this.publish(entry);
  }

  /** The whole output of command `id` so far (or its end, `cut` when that is all). */
  replace(id: string, whole: string, cut = false): void {
    const entry = this.commands.get(id);
    if (!entry || entry.info.status !== "running") return;
    const before = entry.text;
    this.take(entry, whole, cut);
    if (entry.text !== before) this.publish(entry);
  }

  /**
   * Reads command `id`'s output from the file its agent writes it to, once a second while
   * it runs: only the file's end, and only a plain file (not a link) at `path`.
   */
  follow(id: string, path: string): void {
    const entry = this.commands.get(id);
    if (!entry || entry.info.status !== "running" || entry.file) return;
    entry.file = { path, reading: false };
    this.read(entry);
  }

  /**
   * Command `id` ended: its row says how, with the end of its output: the one given, else
   * its output file's end read once more, else what was read last.
   */
  end(id: string, status: Exclude<SubagentStatus, "running">, final?: { output?: string; result?: string }): void {
    const entry = this.commands.get(id);
    if (!entry || entry.info.status !== "running") return;
    this.stopTimers(entry);
    entry.info.status = status;
    entry.info.endedAt = this.now();
    entry.info.stoppable = false;
    if (final?.result) entry.info.result = final.result.slice(0, 2000);
    if (final?.output !== undefined) this.take(entry, final.output, false);
    else if (entry.file) {
      const path = entry.file.path;
      void tailOf(path).then((tail) => {
        if (this.commands.get(id) !== entry) return;
        if (tail) this.take(entry, tail.text, tail.cut);
        this.send(entry);
      });
      return;
    }
    this.send(entry);
  }

  /** Every command still running is no longer followed (the agent's process went away). */
  close(result = "Portals stopped following this command."): void {
    for (const [id, entry] of this.commands) if (entry.info.status === "running") this.end(id, "stopped", { result });
    for (const entry of this.commands.values()) this.stopTimers(entry);
  }

  private forget(id: string): void {
    const entry = this.commands.get(id);
    if (entry) this.stopTimers(entry);
    this.commands.delete(id);
  }

  private stopTimers(entry: Command): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.file?.timer) clearTimeout(entry.file.timer);
    if (entry.file) entry.file.timer = undefined;
  }

  private take(entry: Command, text: string, cut: boolean): void {
    const limit = 16_384;
    entry.text = text.length > limit ? text.slice(-limit) : text;
    entry.dropped = cut || text.length > limit;
    const tail = outputTail(asShown(entry.text));
    entry.info.output = tail.output;
    entry.info.outputTruncated = tail.truncated || entry.dropped;
    const last = tail.output.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1);
    entry.info.summary = last?.slice(0, 300);
  }

  private publish(entry: Command): void {
    if (entry.timer) return;
    const wait = entry.sentAt === undefined ? 0 : entry.sentAt + this.interval - this.now();
    if (wait <= 0) {
      this.send(entry);
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.commands.get(entry.info.id) === entry && entry.info.status === "running") this.send(entry);
    }, wait);
    entry.timer.unref();
  }

  private send(entry: Command): void {
    entry.sentAt = this.now();
    this.emit({ type: "subagent", subagent: { ...entry.info } });
  }

  private read(entry: Command): void {
    const file = entry.file;
    if (!file || file.reading || entry.info.status !== "running") return;
    file.reading = true;
    void tailOf(file.path).then((tail) => {
      file.reading = false;
      if (this.commands.get(entry.info.id) !== entry || entry.info.status !== "running") return;
      if (tail) this.replace(entry.info.id, tail.text, tail.cut);
      file.timer = setTimeout(() => this.read(entry), this.poll);
      file.timer.unref();
    });
  }
}

/** The end of a plain file, at most 16 KB of it; null for a link, a folder or one that cannot be read. */
async function tailOf(path: string): Promise<{ text: string; cut: boolean } | null> {
  try {
    // Opened without following a link, and checked as opened: a file swapped for a link
    // after a check would otherwise be read.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      const length = Math.min(stat.size, 16_384);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
      let start = 0;
      // Never begin in the middle of a UTF-8 character.
      while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
      return { text: buffer.subarray(start, bytesRead).toString(), cut: stat.size > length };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
