import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { StoredMessage } from "../types.ts";
import type { PiBlock, PiEntry, PiMessage } from "./protocol.ts";
import { piTokens, TurnTokens } from "../spent.ts";
import { contentText, errorText, gatewayResult, gatewayTool, isAbortError, saysAborted, stoppedResult } from "./tools.ts";

// A Pi session file in the shape `session.resume` returns (docs/gateway-protocol.md,
// section 8), read with no Pi running: the user's messages, the assistant's text with
// its thinking, one tool message per tool call with its result, and a mark where Pi
// summarised the conversation.
//
// The file is a tree (Pi's docs/session-format.md): each line after the header is an
// entry with an `id` and a `parentId`, and the conversation is the path from the last
// entry back to the first. Entries Pi has summarised are still on it, so a compacted
// thread shows everything that was said. Each entry says when it was written, and each
// message when it was made: a message Pi queued while it worked was made before the
// entry it follows was written, which is how one is told from a message that opens a turn.
//
// Pi's file says less than a live turn in three places. It does not say that a turn was
// stopped while a command ran: it ends with an empty assistant message whose
// `stopReason` is `error` ("This operation was aborted"), which is read as an
// interruption and not as a failure. It does not say why a compaction happened, so
// every one is marked as Pi's own. And it stores nothing of a command Pi handled itself
// (an extension's, or `/compact`), so such a turn is not in it at all.

export interface PiHistory {
  messages: StoredMessage[];
  /** The name Pi has for the session (`/name`, or the title the bridge gave it), if any. */
  title: string | null;
  /** The file it was read from and how many bytes were read, when there was one to read. */
  read?: { file: string; size: number };
}

// MARK: Where the file is

/** A folder as Pi reads one from its environment: `~` is the home folder. */
function fromEnvironment(set: string): string {
  if (set === "~") return homedir();
  return set.startsWith("~/") ? join(homedir(), set.slice(2)) : set;
}

/** Pi's own folder: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export function agentFolder(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.PI_CODING_AGENT_DIR;
  return set ? fromEnvironment(set) : join(homedir(), ".pi", "agent");
}

/**
 * The one folder Pi keeps every session in when its environment says so
 * (`$PI_CODING_AGENT_SESSION_DIR`, which a Pi the bridge starts has from the bridge):
 * no folder per working folder there. Null when it does not, and the sessions are under
 * Pi's own folder. `cwd` is the thread's folder, which Pi runs in.
 */
export function movedSessions(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const set = env.PI_CODING_AGENT_SESSION_DIR;
  return set ? resolve(cwd, fromEnvironment(set)) : null;
}

/** The folder under `sessions/` that Pi keeps a working folder's sessions in: the path with `-` for each `/` and `:`. */
export function sessionFolderName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * The session id a session file's name carries: Pi names a file `<when it began>_<id>.jsonl`,
 * and the time has no `_` in it, so the id is what follows the first one (an id may hold
 * more). Null for a name that is not such a file's.
 */
export function sessionFileId(name: string): string | null {
  const at = name.indexOf("_");
  return at > 0 && name.endsWith(".jsonl") && name.length > at + 1 + ".jsonl".length ? name.slice(at + 1, -".jsonl".length) : null;
}

/**
 * The session file of the thread `id` that ran in `cwd`: the one Pi named
 * `<time>_<id>.jsonl`, looked for in the folder the environment moves Pi's sessions to
 * (when it does), then in the folder Pi names after `cwd` and, when it is not there, in
 * every other folder of sessions (the id is the thread's own, so a match is the thread's,
 * and another release of Pi may name the folder otherwise). Null when there is none: a
 * thread with no message yet, or a session deleted at the desk.
 */
export async function findSessionFile(id: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const sessions = join(agentFolder(env), "sessions");
  // Pi names the folder after the path its process runs in, which is the real one.
  const real = await realpath(cwd).catch(() => cwd);
  const expected = [...new Set([sessionFolderName(real), sessionFolderName(cwd)])];
  const others = await readdir(sessions, { withFileTypes: true }).then(
    (entries) => entries.filter((entry) => entry.isDirectory() && !expected.includes(entry.name)).map((entry) => entry.name).sort(),
    () => [] as string[],
  );
  const moved = movedSessions(env, real);
  for (const folder of [...(moved ? [moved] : []), ...[...expected, ...others].map((name) => join(sessions, name))]) {
    const files = await readdir(folder).catch(() => [] as string[]);
    // The name starts with when the session began; the newest wins if there were ever two.
    const file = files.filter((name) => sessionFileId(name) === id).sort().at(-1);
    if (file) return join(folder, file);
  }
  return null;
}

/**
 * Every folder that holds session files, whatever folder the sessions ran in: each folder
 * under Pi's own `sessions/`, or the one folder the environment moves them all to. A
 * `$PI_CODING_AGENT_SESSION_DIR` that is not a whole path is another folder for every
 * working folder, which nothing lists: none then.
 */
export async function sessionFolders(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const set = env.PI_CODING_AGENT_SESSION_DIR;
  if (set) {
    const moved = fromEnvironment(set);
    return isAbsolute(moved) ? [moved] : [];
  }
  const sessions = join(agentFolder(env), "sessions");
  const entries = await readdir(sessions, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessions, entry.name)).sort();
}

/** The session file at `path` as history; empty when there is no path or no file. */
export async function readHistory(path: string | null, cwd: string, open = false): Promise<PiHistory> {
  if (!path) return { messages: [], title: null };
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return historyFromSession("", cwd, open);
  return { ...historyFromSession(text, cwd, open), read: { file: path, size: Buffer.byteLength(text) } };
}

// MARK: The entries

/** The entries on the path from the file's last entry back to its first, oldest first. */
function conversation(text: string): PiEntry[] {
  const byId = new Map<string, PiEntry>();
  let last: PiEntry | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: PiEntry;
    try {
      entry = JSON.parse(line) as PiEntry;
    } catch {
      // A line cut off mid-write (Pi was killed): what came before it still reads.
      continue;
    }
    // The header (`type: "session"`) has no id and is not part of the tree.
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
    byId.set(entry.id, entry);
    last = entry;
  }
  const path: PiEntry[] = [];
  const seen = new Set<string>();
  for (let entry: PiEntry | null | undefined = last; entry && !seen.has(entry.id!); entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : null) {
    seen.add(entry.id!);
    path.push(entry);
  }
  return path.reverse();
}

/**
 * A time in seconds: the message's own (milliseconds), else the entry's (ISO 8601), and
 * never earlier than the one before. A message Pi queued keeps the time it was queued,
 * which is before what it follows in the file.
 */
function seconds(entry: PiEntry, previous: number): number {
  const own = entry.message?.timestamp;
  if (typeof own === "number" && own > 0) return Math.max(previous, own / 1000);
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isNaN(parsed) ? previous : Math.max(previous, parsed / 1000);
}

/** When an entry was written, in milliseconds; 0 when it does not say. */
function written(entry: PiEntry): number {
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function extension(mimeType: unknown): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

/** A skill as Pi stores the message that ran it: the skill's whole text, then what was typed after its name. Pi's own pattern. */
const expandedSkill = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** A user message as the bridge stores one it sends: the text, then one `@image:` line per image. */
export function userText(content: PiMessage["content"]): string {
  const blocks: PiBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const lines: string[] = [];
  const images: string[] = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string" && block.text !== "") lines.push(block.text);
    else if (block?.type === "image") images.push(`@image:image-${images.length + 1}.${extension(block.mimeType)}`);
  }
  let said = lines.join("\n");
  // `/skill:greet Ada` reads as it was typed, not as the skill's text.
  const skill = expandedSkill.exec(said);
  if (skill) said = `/skill:${skill[1]}${skill[2] ? ` ${skill[2]}` : ""}`;
  return [said, ...images].filter((line) => line !== "").join("\n");
}

/**
 * The conversation in `text`, a session file's content. `cwd` is the thread's folder,
 * for paths in diffs. With `open`, a Pi may be in the middle of a turn on the file (a
 * session only read, while one runs in its folder's terminal): the calls at the file's
 * end that have no result yet may still be running, and get no row until they have one.
 */
export function historyFromSession(text: string, cwd: string, open = false): PiHistory {
  const entries = conversation(text);
  const messages: StoredMessage[] = [];
  let title: string | null = null;
  let time = 0;
  /** Tool calls not answered yet, by id, in the order they were made. */
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** The role of the message before, what it said if it was a tool's result, and when its entry was written. */
  let before: { role: string; said: string; written: number } | null = null;

  const tool = (id: string, name: string, input: Record<string, unknown>, result: unknown): void => {
    const row = gatewayTool(name, input);
    const message: StoredMessage = { role: "tool", name: row.name, args: row.args, content: JSON.stringify(result), tool_call_id: id, timestamp: time };
    if (row.context) message.context = row.context;
    messages.push(message);
  };
  /** Calls with no result by now never got one: Pi died while they ran, or was stopped. */
  const closeCalls = (): void => {
    for (const [id, call] of calls) tool(id, call.name, call.input, stoppedResult);
    calls.clear();
  };
  /** Whether Pi tried again after the attempt at `index`: another assistant message before the user's next. */
  const retried = (index: number): boolean => {
    for (let next = index + 1; next < entries.length; next += 1) {
      const later = entries[next];
      if (later.type !== "message") continue;
      if (later.message?.role === "assistant") return true;
      if (later.message?.role === "user") return false;
    }
    return false;
  };

  // What each turn spent, from each of Pi's requests (feature turn_usage).
  const spent = new TurnTokens();
  entries.forEach((entry, index) => {
    if (entry.type === "session_info") {
      title = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : null;
      return;
    }
    if (entry.type === "compaction") {
      time = seconds(entry, time);
      const mark: StoredMessage = { role: "compaction", trigger: "auto", timestamp: time };
      if (typeof entry.tokensBefore === "number" && entry.tokensBefore > 0) mark.tokens_before = entry.tokensBefore;
      messages.push(mark);
      before = null;
      return;
    }
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message) return;
    switch (message.role) {
      case "user": {
        time = seconds(entry, time);
        closeCalls();
        const said = userText(message.content);
        if (said === "") break;
        // A message sent while Pi worked keeps the time it was sent, which is before
        // the reply or the tool result it follows was written: Pi took it into the
        // run. One sent to a Pi at rest is newer than what it follows, also when that
        // is a tool's result (the run before it was cut there).
        const sent = message.timestamp;
        const steered = before !== null && typeof sent === "number" && sent > 0 && sent < before.written;
        spent.close(messages);
        messages.push(steered ? { role: "user", text: said, timestamp: time, display_kind: "steer" } : { role: "user", text: said, timestamp: time });
        before = { role: "user", said: "", written: written(entry) };
        break;
      }
      case "assistant": {
        time = seconds(entry, time);
        spent.add(piTokens(message.usage));
        const blocks = Array.isArray(message.content) ? message.content : [];
        let said = "";
        const thought: string[] = [];
        for (const block of blocks) {
          if (block?.type === "text" && typeof block.text === "string") said += block.text;
          else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== "") thought.push(block.thinking.trimEnd());
          else if (block?.type === "toolCall" && typeof block.id === "string") calls.set(block.id, { name: block.name ?? "tool", input: block.arguments ?? {} });
        }
        const reply: StoredMessage = { role: "assistant", text: said, timestamp: time };
        if (thought.length > 0) reply.reasoning = thought.join("\n\n");
        const empty = said.trim() === "" && thought.length === 0;
        const error = message.stopReason === "error";
        // Stop while a command ran: Pi stores the request it then did not make as an error.
        const stopped = message.stopReason === "aborted" || (error && blocks.length === 0 && (isAbortError(message.errorMessage) || (before?.role === "toolResult" && saysAborted(before.said))));
        if (stopped) {
          messages.push({ ...reply, display_metadata: { interrupted: true } });
        } else {
          if (!empty) messages.push(reply);
          // An attempt Pi tried again keeps what it said and loses its error.
          if (error && !retried(index)) messages.push({ role: "assistant", text: errorText(message.errorMessage ?? "") || "Pi stopped with an error.", timestamp: time, display_kind: "failed_turn" });
        }
        before = { role: "assistant", said: "", written: written(entry) };
        break;
      }
      case "toolResult": {
        time = seconds(entry, time);
        const id = message.toolCallId ?? "";
        const call = calls.get(id) ?? { name: message.toolName ?? "tool", input: {} };
        calls.delete(id);
        const outcome = { content: message.content, isError: message.isError === true, ran: typeof message.durationMs === "number", details: message.details };
        tool(id, call.name, call.input, gatewayResult(call.name, call.input, outcome, cwd));
        before = { role: "toolResult", said: contentText(message.content), written: written(entry) };
        break;
      }
      default:
        // System messages, an extension's own, a `!` command's output and summaries are not shown.
        break;
    }
  });
  if (!open) closeCalls();
  spent.close(messages);
  return { messages, title };
}
