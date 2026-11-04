import { log } from "../../log.ts";
import { readJSON, writeJSON } from "../../store/jsonFile.ts";

// What the user typed for the messages Hermes stored in its place. A command Hermes makes
// a message of (`command.dispatch`: `/plan`, `/init`, a skill) goes to Hermes as that
// message, which is what Hermes stores, so the thread read back (after a restart of the
// bridge, or Hermes's copy taken after a reconnect) would show it in place of the
// command. Kept by thread and by the id of the row Hermes stored (`prompt.submit`'s
// `user_row_id`), the latest of each thread, in the bridge's state.

/** How many of each thread's are kept. */
const keptPerThread = 50;

export class TypedCommands {
  private readonly path: string;
  /** By thread: the stored row's id and what the user typed, oldest first. Read once, when first asked. */
  private threads: Record<string, [number, string][]> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /** The thread's, by the stored row's id. */
  of(thread: string): Map<number, string> {
    return new Map(this.read()[thread] ?? []);
  }

  /** Keeps `text` as what the user typed for the thread's stored row `row`. */
  keep(thread: string, row: number, text: string): void {
    const threads = this.read();
    threads[thread] = [...(threads[thread] ?? []).filter(([id]) => id !== row), [row, text] as [number, string]].slice(-keptPerThread);
    try {
      writeJSON(this.path, { threads });
    } catch (error) {
      log.warn("could not keep what was typed for a Hermes command", { error: (error as Error).message });
    }
  }

  private read(): Record<string, [number, string][]> {
    if (this.threads) return this.threads;
    const found = readJSON<{ threads?: unknown }>(this.path, {})?.threads;
    const threads: Record<string, [number, string][]> = {};
    if (typeof found === "object" && found !== null && !Array.isArray(found)) {
      for (const [thread, rows] of Object.entries(found)) {
        if (!Array.isArray(rows)) continue;
        threads[thread] = rows.filter((row): row is [number, string] => Array.isArray(row) && Number.isInteger(row[0]) && typeof row[1] === "string");
      }
    }
    this.threads = threads;
    return threads;
  }
}
