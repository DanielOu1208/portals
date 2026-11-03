import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathsFor } from "../../src/config.ts";
import type { StoredMessage } from "../../src/providers/types.ts";
import type { ThreadRecord } from "../../src/sessions/registry.ts";
import { writeJSON } from "../../src/store/jsonFile.ts";

// A bridge's list of N threads, written before the bridge starts: `state/threads.json`
// and, for each thread, the scripted agent's conversation in `state/fake/`. Making 5000
// threads through `session.create` would take longer than the run.
//
// The records are shaped like real ones, since their size decides several numbers. What
// they are made of is fixed here (`recipe`) and goes into the harness's JSON, and the
// same seed gives the same list every time, so two runs measure the same thing.

export const recipe = {
  /** The scripted agent's pause between words (config.json's `fake.delayMs`); `slow` is eight times it. */
  delayMs: 1,
  /** What each measured turn sends: none of the scripted agent's step words is in it. */
  prompt: "Please summarise what changed in the sync layer since yesterday",
  /** What a streamed turn sends: `slow` makes the long reply. */
  slowPrompt: "A slow reply this time",
  /** Folders under the scratch root that the threads are spread over. */
  folders: 20,
  /** Characters in a title; the bridge allows 200. */
  title: [40, 120],
  /** Characters in a preview; the bridge cuts one at 140. */
  preview: [20, 140],
  /** One title and preview in this many is not ASCII. */
  notAsciiEvery: 5,
  /** One thread in this many is pinned, and one archived. */
  markedEvery: 20,
  /** Messages in a thread's conversation unless a scenario says, and the characters of each. */
  messages: 2,
  userText: [60, 120],
  assistantText: [300, 600],
  /** The one thread with a long last turn (`long`): its reply, its reasoning and a tool's output, in characters. */
  longReply: 20_000,
  longReasoning: 2000,
  longToolOutput: 10_000,
  seed: 20261012,
} as const;

export interface RegistryOptions {
  threads: number;
  /** Messages in each conversation; `recipe.messages` when left out. */
  messages?: number;
  /** The first thread's last turn is the long one. */
  long?: boolean;
}

export interface WrittenRegistry {
  /** The threads' ids, newest first. */
  ids: string[];
  /** The size of threads.json as written. */
  bytes: number;
  bytesPerRecord: number;
  /** The mean length of a record's folder path: the scratch root's own length is in it. */
  folderChars: number;
}

const words = "sync fleet thread bridge poll merge counters revision device sidebar archive rename pinned window build review plan budget list write change update remove agent session folder project notes draft report".split(" ");
const notAscii = ["café", "naïve", "über", "résumé", "日本語", "修正", "测试", "🚀", "Zürich", "señal"];

/** A small seeded generator (mulberry32): the same list every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Writes the list and its conversations into the bridge folder `home`, with the threads' folders made under `foldersRoot`. */
export function writeRegistry(home: string, foldersRoot: string, options: RegistryOptions): WrittenRegistry {
  const paths = pathsFor(home);
  mkdirSync(paths.fake, { recursive: true, mode: 0o700 });
  const random = seeded(recipe.seed);
  const between = ([least, most]: readonly [number, number]) => least + Math.floor(random() * (most - least + 1));
  const text = (length: number, plain: boolean) => {
    let made = "";
    while (made.length < length) {
      const from = plain || random() > 0.3 ? words : notAscii;
      made += (made === "" ? "" : " ") + from[Math.floor(random() * from.length)];
    }
    return [...made].slice(0, length).join("").trimEnd();
  };
  const hex = (length: number) => Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join("");

  const folders = Array.from({ length: recipe.folders }, (_, index) => join(foldersRoot, `project-${String(index + 1).padStart(2, "0")}`));
  for (const folder of folders) mkdirSync(folder, { recursive: true });

  // Newest first, a few minutes apart, ending a few minutes ago.
  const now = Math.floor(Date.now() / 1000);
  const records: ThreadRecord[] = [];
  for (let index = 0; index < options.threads; index += 1) {
    const plain = index % recipe.notAsciiEvery !== recipe.notAsciiEvery - 1;
    const updatedAt = now - 300 - index * 400;
    const record: ThreadRecord = {
      id: `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`,
      agent: "fake",
      cwd: folders[index % folders.length],
      title: text(between(recipe.title), plain),
      model: "fake-1",
      provider: "fake",
      reasoningEffort: "medium",
      createdAt: updatedAt - 3600,
      updatedAt,
      origin: "phone",
      preview: text(between(recipe.preview), plain),
      // Each last changed at a revision of its own, the newest thread at the newest.
      revision: options.threads - index,
      turnRevision: options.threads - index,
    };
    if (index % recipe.markedEvery === 3) record.pinned = true;
    if (index % recipe.markedEvery === 11) record.archived = true;
    records.push(record);

    const messages: StoredMessage[] = [];
    const count = options.messages ?? recipe.messages;
    for (let message = 0; message < count; message += 1) {
      const timestamp = updatedAt - (count - message) * 30;
      if (message % 2 === 0) messages.push({ role: "user", text: text(between(recipe.userText), plain), timestamp });
      else messages.push({ role: "assistant", text: text(between(recipe.assistantText), plain), timestamp });
    }
    if (options.long && index === 0) {
      messages.push({ role: "user", text: text(between(recipe.userText), true), timestamp: updatedAt - 20 });
      messages.push({ role: "tool", name: "terminal", args: { command: "npm test" }, content: text(recipe.longToolOutput, true), tool_call_id: "bench-tool-1", timestamp: updatedAt - 10 });
      messages.push({ role: "assistant", text: text(recipe.longReply, true), reasoning: text(recipe.longReasoning, true), timestamp: updatedAt });
    }
    writeFileSync(join(paths.fake, `${record.id}.json`), JSON.stringify({ messages, titled: true }), { mode: 0o600 });
  }

  // With the list's id and revision, so the bridge takes it as its list (without them
  // it would make a new one at its start), and through the bridge's own writer, so the
  // file is the size the bridge's next save makes it.
  writeJSON(paths.threads, { list: hex(16), revision: options.threads, threads: records });
  const bytes = statSync(paths.threads).size;
  return {
    ids: records.map((record) => record.id),
    bytes,
    bytesPerRecord: options.threads === 0 ? 0 : Math.round(bytes / options.threads),
    folderChars: Math.round(records.reduce((total, record) => total + record.cwd.length, 0) / Math.max(records.length, 1)),
  };
}
