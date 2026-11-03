import { open } from "node:fs/promises";
import type { StoredMessage } from "../providers/types.ts";
import { holds, mayHold, mayHoldUnfolded, type Query } from "./match.ts";

// The words of a thread as its agent keeps them, read for a search (feature
// thread_search) without loading the thread: only the user's messages and the agent's
// replies, each with its time and, where the file has one, the agent's own id for it.
//
// Claude Code, Codex and Pi keep a session as JSON lines, one record a line; the bridge
// keeps Droid's, Cursor's and the fake agent's as one JSON file of stored messages.
// A JSON-lines file is read in chunks, and each line is tested for the query's words
// (`mayHold`) before it is parsed: most of a session's bytes are tool calls and their
// output, which never hold a hit, and are never parsed.

/** How a thread's file is written (`Provider.searchFile`). */
export type SearchFormat = "claude" | "codex" | "pi" | "stored";

/** Where an agent keeps a thread's conversation, and how it is written. */
export interface SearchFile {
  path: string;
  format: SearchFormat;
  /**
   * The conversation as the agent tells it, which the bridge's history reads: Claude
   * Code's (`getSessionMessages`), each entry with its `uuid`, from its latest compaction
   * on. Asked only for a thread with a compaction and a hit (`compactionView`).
   */
  shown?: () => Promise<readonly unknown[]>;
}

/** A message of a thread, as searched. */
export interface SearchedMessage {
  role: "user" | "assistant";
  text: string;
  /** Unix seconds; 0 when the file does not say. */
  timestamp: number;
  /** The agent's own id for the message, where its file has one. */
  id?: string;
}

/** How much of the work a scan may still do, shared by every file of a page. */
export interface Budget {
  /** Bytes it may still read. */
  bytes: number;
  /** Stops the scan: the search was replaced, its caller went, or its time is up. */
  signal: AbortSignal;
  /** Gives the event loop its turn when the scan has had the thread long enough. */
  pause(): Promise<void>;
}

/** The read is cut short: the budget is spent, or the search is stopped. */
export class ScanStopped extends Error {}

/** The most read of one file: a larger one is searched in its last this many bytes. */
export const fileLimit = 64 * 1024 * 1024;
const chunkSize = 1024 * 1024;

type Json = Record<string, any>;

function seconds(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed / 1000;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value / 1000 : value;
  return 0;
}

/** The text blocks of a message's content (a string, or blocks of `type` among `kinds`), joined by line breaks. */
function blocksText(content: unknown, kinds: readonly string[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: Json) => block && kinds.includes(block.type) && typeof block.text === "string")
    .map((block: Json) => block.text as string)
    .join("\n");
}

// MARK: Claude Code

/** What Claude Code wrote in the user's place, which no one typed: commands' output, caveats, interruptions. */
function claudeUserText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("[Request interrupted by user")) return null;
  const command = /<command-name>([^<]*)<\/command-name>/.exec(trimmed);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(trimmed)?.[1]?.trim() ?? "";
    return [command[1].trim(), args].filter((part) => part !== "").join(" ");
  }
  if (trimmed.startsWith("<local-command-") || trimmed.startsWith("Caveat: The messages below were generated")) return null;
  if (trimmed.startsWith("<task-notification>") || trimmed.startsWith("<system-reminder>")) return null;
  return text;
}

/**
 * A line of a Claude Code session file (`~/.claude/projects/<folder>/<id>.jsonl`): a
 * `user` record whose content is the user's text (not a tool's result), or an
 * `assistant` record's text blocks. A subagent's (`isSidechain`), Claude Code's own
 * (`isMeta`) and a compaction's summary (`isCompactSummary`) are not the conversation.
 */
export function claudeMessage(record: Json): SearchedMessage | null {
  if (record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true) return null;
  const content = record.message?.content;
  if (record.type === "user") {
    const text = claudeUserText(blocksText(content, ["text"]));
    return text ? { role: "user", text, timestamp: seconds(record.timestamp), ...(typeof record.uuid === "string" ? { id: record.uuid } : {}) } : null;
  }
  if (record.type === "assistant") {
    const text = blocksText(content, ["text"]);
    return text.trim() !== "" ? { role: "assistant", text, timestamp: seconds(record.timestamp), ...(typeof record.uuid === "string" ? { id: record.uuid } : {}) } : null;
  }
  return null;
}

// MARK: Codex

/**
 * A line of a Codex rollout file (`~/.codex/sessions/…/rollout-…-<id>.jsonl`). Codex
 * since 0.150 writes each finished item (`event_msg` of type `item_completed`), whose
 * `UserMessage` and `AgentMessage` are what the thread shows; before, `event_msg`s of type
 * `user_message` and `agent_message`. The `response_item` messages are what the model was
 * sent, the instructions and the folder's context among them, and are not read.
 */
export function codexMessage(record: Json): SearchedMessage | null {
  if (record.type !== "event_msg") return null;
  const payload = record.payload ?? {};
  const timestamp = seconds(record.timestamp);
  if (payload.type === "item_completed") {
    const item = payload.item ?? {};
    const id = typeof item.id === "string" ? { id: item.id } : {};
    if (item.type === "UserMessage") {
      const text = blocksText(item.content, ["text", "Text"]);
      return text.trim() !== "" ? { role: "user", text, timestamp, ...id } : null;
    }
    if (item.type === "AgentMessage") {
      const text = blocksText(item.content, ["text", "Text"]);
      return text.trim() !== "" ? { role: "assistant", text, timestamp, ...id } : null;
    }
    return null;
  }
  if (payload.type === "user_message" && typeof payload.message === "string" && payload.message.trim() !== "") {
    return { role: "user", text: payload.message, timestamp };
  }
  if (payload.type === "agent_message" && typeof payload.message === "string" && payload.message.trim() !== "") {
    return { role: "assistant", text: payload.message, timestamp };
  }
  return null;
}

// MARK: Pi

/**
 * A line of a Pi session file: a `message` entry whose message is the user's or the
 * assistant's (a tool's result is `toolResult`). Every branch of the session is read,
 * the ones left behind by a fork too.
 */
export function piMessage(record: Json): SearchedMessage | null {
  if (record.type !== "message") return null;
  const message = record.message ?? {};
  if (message.role !== "user" && message.role !== "assistant") return null;
  const text = blocksText(message.content, ["text"]);
  if (text.trim() === "") return null;
  const own = typeof message.timestamp === "number" && message.timestamp > 0 ? message.timestamp / 1000 : seconds(record.timestamp);
  return { role: message.role, text, timestamp: own, ...(typeof record.id === "string" ? { id: record.id } : {}) };
}

/**
 * Where Claude Code compacted the conversation: its summary of what came before, in the
 * user's place (`isCompactSummary`), which follows the `compact_boundary` record and
 * comes before the `/compact` that asked for it. The thread's messages, as the app is
 * shown them, start again there (`claude/history.ts` marks its place with a `compaction`
 * row at the summary's time): what was said before is in the file, not in the thread.
 * Which messages that hides is the session's chain's to say (`compactionView`).
 */
const claudeCompactionMark = '"isCompactSummary":true';
const claudeUserMark = '"type":"user"';
const claudeToolResultMark = '"type":"tool_result"';

/** The time of a Claude Code compaction's summary, or null for a line that is not one. */
export function claudeCompaction(record: Json): number | null {
  if (record.type !== "user" || record.isCompactSummary !== true || record.isSidechain === true) return null;
  return seconds(record.timestamp);
}

/**
 * Which hits of a Claude Code thread it no longer shows for its latest compaction, and
 * that compaction's time (its row's in the bridge's history): read from the conversation
 * as Claude Code tells it (`SearchFile.shown`, the SDK's `getSessionMessages`, which
 * follows the session's chain of messages from its last one back to its latest
 * compaction, through branches, kept messages and all). A hit is hidden when it is not
 * in it and was said before the compaction's summary. Null when it has no compaction.
 */
export async function compactionView(shown: readonly unknown[]): Promise<{ shownIds: Set<string>; compactedAt: number } | null> {
  const shownIds = new Set<string>();
  let compactedAt: number | null = null;
  for (const entry of shown as Json[]) {
    if (typeof entry?.uuid === "string") shownIds.add(entry.uuid);
    const at = entry ? claudeCompaction(entry) : null;
    if (at !== null) compactedAt = at;
  }
  return compactedAt === null ? null : { shownIds, compactedAt };
}

/** A line's message for each format of JSON lines. */
const lineReaders: Record<Exclude<SearchFormat, "stored">, (record: Json) => SearchedMessage | null> = {
  claude: claudeMessage,
  codex: codexMessage,
  pi: piMessage,
};

/**
 * The cheapest test a line must pass before anything else: the kinds of record that can
 * hold a message, by a string every such line has. A line without it is not even folded.
 */
const lineMarks: Record<Exclude<SearchFormat, "stored">, readonly string[]> = {
  claude: [claudeUserMark, '"type":"assistant"'],
  codex: ['"UserMessage"', '"AgentMessage"', '"user_message"', '"agent_message"'],
  pi: ['"type":"message"'],
};

// MARK: Stored messages

/** The user's and the agent's messages of the bridge's own stored conversation (`{messages: StoredMessage[]}`). */
export function storedMessages(messages: readonly StoredMessage[]): SearchedMessage[] {
  const found: SearchedMessage[] = [];
  for (const message of messages) {
    if ((message.role === "user" || message.role === "assistant") && typeof message.text === "string" && message.text.trim() !== "") {
      // A row the bridge wrote for something other than a message (a failed turn, a command's output) is not one.
      if (message.role === "assistant" && message.display_kind === "failed_turn") continue;
      // In seconds, as the protocol's are: Droid's record keeps milliseconds (its `history()` divides them too).
      found.push({ role: message.role, text: message.text, timestamp: seconds(message.timestamp) });
    }
  }
  return found;
}

// MARK: Reading

/**
 * The messages of the file that hold every word of the query, in the file's order, each
 * given to `hit`, and in the same order each compaction after which the thread no longer
 * shows what came before (Claude Code's, `claudeCompaction`), its time given to
 * `compacted`. Returns whether the file was read only in part (larger than
 * `fileLimit`). Throws `ScanStopped` when the search is stopped: what was given to
 * `hit` stays given. The bytes read are taken from the budget; the page checks what is
 * left between threads, so that a thread is always searched whole.
 *
 * Codex's rollout marks its compactions too (`compacted`, `context_compacted`), and Pi's
 * session file (`compaction` entries), and the bridge's own record (`compaction` rows):
 * none of them is given, because each of those threads still shows what was said before
 * its compaction (Codex's `thread/read` keeps every turn, Pi's history the whole path,
 * the bridge's record every message), so a hit there is found where it is.
 */
export async function scanFile(
  file: SearchFile,
  query: Query,
  budget: Budget,
  hit: (message: SearchedMessage) => void,
  limit = fileLimit,
  compacted: (timestamp: number) => void = () => {},
): Promise<{ partial: boolean; modified: number; size: number }> {
  let handle;
  try {
    handle = await open(file.path, "r");
  } catch {
    return { partial: false, modified: 0, size: 0 };
  }
  try {
    const info = await handle.stat();
    const size = info.size;
    // When it was last written, Unix seconds: what the agent said since is not in it yet.
    const modified = info.mtimeMs / 1000;
    const from = Math.max(0, size - limit);
    if (file.format === "stored") {
      // One larger than the limit is left out: it is one JSON, which cannot be read from its middle.
      if (size > limit) return { partial: true, modified, size };
      await scanStored(handle, size, query, budget, hit);
      return { partial: false, modified, size };
    }
    const read = lineReaders[file.format];
    const marks = lineMarks[file.format];
    const decoder = new TextDecoder("utf-8");
    let rest = "";
    // A file read from its middle starts at the line after.
    let skipFirst = from > 0;
    const line = (text: string) => {
      if (text === "") return;
      const mark = marks.find((each) => text.includes(each));
      if (mark === undefined) return;
      // A user line of Claude Code's that is not a tool's result (most of the bytes, told
      // apart near the line's start) may be a compaction's summary.
      if (mark === claudeUserMark && file.format === "claude" && !text.includes(claudeToolResultMark) && text.includes(claudeCompactionMark)) {
        try {
          const at = claudeCompaction(JSON.parse(text));
          if (at !== null) compacted(at);
        } catch {
          // Cut off as it was written.
        }
        return;
      }
      if (!mayHold(text, query)) return;
      let record: Json;
      try {
        record = JSON.parse(text);
      } catch {
        // A line cut off as it was written: what came before still reads.
        return;
      }
      const message = record && typeof record === "object" ? read(record) : null;
      if (message && holds(message.text, query)) hit(message);
    };
    const buffer = Buffer.allocUnsafe(chunkSize);
    for (let position = from; position < size; ) {
      if (budget.signal.aborted) throw new ScanStopped();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkSize, size - position), position);
      if (bytesRead === 0) break;
      position += bytesRead;
      budget.bytes -= bytesRead;
      const text = rest + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      for (let index = 0; index < lines.length; index += 1) {
        if (skipFirst) {
          skipFirst = false;
          continue;
        }
        line(lines[index]);
        // A chunk of many lines that hold the words (parsed, matched) gives the loop its turn too.
        if ((index & 31) === 31) await budget.pause();
      }
      await budget.pause();
    }
    if (!skipFirst) line(rest + decoder.decode());
    return { partial: from > 0, modified, size };
  } finally {
    await handle.close();
  }
}

/** A stored conversation, read whole: the bridge's own files are small, and one larger than the limit is left out. */
async function scanStored(handle: Awaited<ReturnType<typeof open>>, size: number, query: Query, budget: Budget, hit: (message: SearchedMessage) => void): Promise<void> {
  if (budget.signal.aborted) throw new ScanStopped();
  budget.bytes -= size;
  const text = await handle.readFile("utf8");
  // A file of plain ASCII without every word is not worth parsing. One with other letters is
  // parsed rather than folded whole: its messages are folded one by one below, the loop
  // given its turn between them.
  if (mayHoldUnfolded(text, query) === false) return;
  let stored: Json;
  try {
    stored = JSON.parse(text);
  } catch {
    return;
  }
  const messages = Array.isArray(stored?.messages) ? (stored.messages as StoredMessage[]) : [];
  let index = 0;
  for (const message of storedMessages(messages)) {
    if (holds(message.text, query)) hit(message);
    if ((++index & 63) === 0) await budget.pause();
  }
  await budget.pause();
}
