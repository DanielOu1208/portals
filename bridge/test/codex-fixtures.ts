import { readFileSync } from "node:fs";
import { CodexStream } from "../src/providers/codex/stream.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

// Recorded Codex streams (scripts/record-codex.ts) and a way to play one through the
// mapper with no Codex at all. test/codex-daemon.ts plays them as a whole daemon.

/** The folder the recordings ran in, after cleaning. */
export const fixtureCwd = "/tmp/aeriportal-cwd";

export interface Entry {
  kind: "meta" | "send" | "response" | "notification" | "request" | "answer" | "history" | "disconnected";
  at: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
  id?: number | string;
  thread?: any;
  thread_id?: string;
  scenario?: string;
  model?: string;
}

export function fixture(name: string): Entry[] {
  const text = readFileSync(new URL(`fixtures/codex/${name}.jsonl`, import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Entry);
}

/** The recording's thread id. */
export function recordedThread(name: string): string {
  return fixture(name).find((entry) => entry.kind === "meta")!.thread_id!;
}

/** The thread as `thread/read` returned it at the end of the recording. */
export function recordedHistory(name: string): any {
  return fixture(name).find((entry) => entry.kind === "history")!.thread;
}

/** Notifications that are about one turn of the thread, as the session hands them to its stream. */
const threadWide = new Set(["thread/tokenUsage/updated", "thread/name/updated"]);

/**
 * The fixture's notifications through one CodexStream, as a session would feed them:
 * each turn the recorder started, one after the other (`thread/compact/start` answers
 * with no turn, which `turn/started` then names).
 */
export function replayStream(name: string): ProviderEvent[] {
  const stream = new CodexStream({ cwd: fixtureCwd, now: () => 0 });
  const thread = recordedThread(name);
  const events: ProviderEvent[] = [];
  let turn: string | null = null;
  for (const entry of fixture(name)) {
    if (entry.kind === "response" && entry.method === "turn/start" && turn === null) {
      turn = entry.result.turn.id;
      stream.beginTurn(turn!);
    }
    if (entry.kind !== "notification" || entry.params?.threadId !== thread) continue;
    const method = entry.method!;
    if (method === "turn/started" && turn === null) {
      turn = entry.params.turn.id;
      stream.beginTurn(turn!);
    }
    const turnScoped = typeof entry.params.turnId === "string" && !threadWide.has(method);
    if (turnScoped && entry.params.turnId !== turn) continue;
    if (method === "turn/completed" && entry.params.turn.id !== turn) continue;
    events.push(...stream.map(method, entry.params));
    if (method === "turn/completed") turn = null;
  }
  return events;
}

/** Events with each run of text or reasoning pieces joined into one, for reading and comparing. */
export function joined(events: ProviderEvent[]): unknown[] {
  const out: any[] = [];
  for (const event of events) {
    const last = out.at(-1);
    if ((event.type === "text" || event.type === "reasoning") && last?.type === event.type) {
      last.text += event.text;
      last.pieces += 1;
    } else if (event.type === "text" || event.type === "reasoning") {
      out.push({ ...event, pieces: 1 });
    } else {
      out.push(event);
    }
  }
  return out;
}

/** `value` with the recording's folder (and thread id) replaced in every string. */
export function rewrite<T>(value: T, replacements: [string, string][]): T {
  if (value === undefined) return value;
  let text = JSON.stringify(value);
  for (const [from, to] of replacements) if (from !== to) text = text.split(from).join(to);
  return JSON.parse(text) as T;
}
