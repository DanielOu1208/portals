import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReadRequest } from "../src/usage/readers/common.ts";
import { Scanner, type Cursor, type ScanMessage, type ScannerOptions } from "../src/usage/scanner.ts";

// Helpers for the usage tests (usage-*.test.ts): a home with the agents' history copied
// from the fixtures (test/fixtures/usage/, a made-up person's sessions, every number
// chosen by hand), and a scan of it in this thread.

const fixtures = fileURLToPath(new URL("./fixtures/usage/", import.meta.url));

/** The fixture folder of each agent, and where it goes in a home. */
const layout = { claude: ".claude", codex: ".codex", pi: ".pi", factory: ".factory" } as const;

/** A new home, with the fixtures of `agents` (all by default) where each agent keeps its history. */
export function historyHome(agents: (keyof typeof layout)[] = ["claude", "codex", "pi", "factory"]): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "portals-usage-test-")));
  for (const agent of agents) cpSync(join(fixtures, agent), join(home, layout[agent]), { recursive: true });
  return home;
}

/** What one scan told. */
export interface Scanned {
  messages: ScanMessage[];
  requests: ReadRequest[];
  files: Extract<ScanMessage, { type: "file" }>[];
  logs: Extract<ScanMessage, { type: "log" }>[];
}

/** One scan with `scanner`, everything it told kept. */
export async function scanOnce(scanner: Scanner): Promise<Scanned> {
  const messages: ScanMessage[] = [];
  await scanner.scan((message) => messages.push(message));
  const files = messages.filter((message): message is Extract<ScanMessage, { type: "file" }> => message.type === "file");
  return { messages, files, requests: files.flatMap((file) => file.requests), logs: messages.filter((message): message is Extract<ScanMessage, { type: "log" }> => message.type === "log") };
}

export function scanner(home: string, options: Partial<ScannerOptions> & { cursors?: Record<string, Cursor> } = {}): Scanner {
  return new Scanner({ home, env: {}, ...options });
}

/** Requests' counts added up. */
export function sum(requests: ReadRequest[]): { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; reasoning: number; requests: number } {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, requests: 0 };
  for (const request of requests) for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += request[key];
  return total;
}
