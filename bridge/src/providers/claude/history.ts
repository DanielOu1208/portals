import { claudeTokens, TurnTokens } from "../spent.ts";
import type { CompactionTrigger, StoredMessage } from "../types.ts";
import { noteFor, notified } from "./background.ts";
import { ClaudeTodos } from "./todos.ts";
import { gatewayResult, gatewayTool } from "./tools.ts";

// A Claude session's stored conversation (`getSessionMessages`) in the shape
// `session.resume` returns (docs/gateway-protocol.md, section 8): user messages, the
// assistant's text and thinking, and one tool message per tool call with its result.
//
// History keeps less than a live turn: no `tool_use_result`, so an edit's diff is made
// from the edit's own old and new text (the bridge puts back the one it saw live, where
// it kept it: src/sessions/keptDiffs.ts), and a question's answer is read from what
// Claude was told. A question is stored as a `clarify` tool message, which the app shows
// as the question and its answer, as it does for Hermes. What Claude Code wrote in the
// user's place when background work ended is stored as the line the app shows for it.
//
// A compaction leaves Claude's summary of the conversation in the user's place
// (`isCompactSummary`), and the session's messages start again there: what came before
// is no longer in them. The summary is written for Claude, so its place is marked
// instead (a `compaction` message), after the `/compact` that asked for it when one
// did. Claude Code stores that command after the summary, and the "Compacted" it printed
// after the command; the mark says as much, so that is left out. History does not keep
// how full the context was, nor what a command that failed said ("No messages to
// compact"): a `/compact` with no summary before it is a turn that failed.

type Message = Record<string, any>;

const interruptedMarker = "[Request interrupted by user";
/** A `/compact` that left no summary behind, as its turn's failure. */
const notCompacted = "The conversation was not compacted.";

function seconds(timestamp: unknown, previous: number): number {
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (!Number.isNaN(parsed)) return parsed / 1000;
  }
  if (typeof timestamp === "number") return timestamp > 1e12 ? timestamp / 1000 : timestamp;
  return previous;
}

/** A user message's text, or null for one that is not the user's to show. */
function userText(content: unknown): string | null {
  if (typeof content === "string") return readable(content);
  if (!Array.isArray(content)) return null;
  // The text, then one `@image:` line per image, as the bridge stores a message it sends.
  const lines: string[] = [];
  const images: string[] = [];
  for (const block of content as Message[]) {
    if (block?.type === "text" && typeof block.text === "string") {
      const text = readable(block.text);
      if (text) lines.push(text);
    } else if (block?.type === "image") {
      images.push(`@image:image-${images.length + 1}.${extension(block.source?.media_type)}`);
    }
  }
  const all = [...lines, ...images];
  return all.length > 0 ? all.join("\n") : null;
}

function extension(mediaType: unknown): string {
  switch (mediaType) {
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

/** Text Claude Code wrote in the user's place, as the user would read it; null to leave it out. */
function readable(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith(interruptedMarker)) return null;
  // A slash command the user ran: `<command-name>/compact</command-name>…<command-args>x</command-args>`.
  const command = /<command-name>([^<]*)<\/command-name>/.exec(trimmed);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(trimmed)?.[1]?.trim() ?? "";
    return [command[1].trim(), args].filter((part) => part !== "").join(" ");
  }
  if (trimmed.startsWith("<local-command-") || trimmed.startsWith("Caveat: The messages below were generated")) return null;
  return text;
}

/** What a local command printed (`<local-command-stdout>…`), shown as the reply. */
function commandOutput(content: unknown): string | null {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block: Message) => (block?.type === "text" ? block.text : "")).join("") : "";
  const output = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
  return output ? output[1].trim() || null : null;
}

export function historyFromSession(messages: readonly unknown[], cwd: string): StoredMessage[] {
  const stored: StoredMessage[] = [];
  const tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** The to-do list Claude kept with its task tools, as it went. */
  const todos = new ClaudeTodos();
  let text = "";
  let reasoning = "";
  let textAt = 0;
  let at = 0;

  const flush = () => {
    if (text.trim() === "" && reasoning.trim() === "") {
      text = "";
      reasoning = "";
      return;
    }
    const message: StoredMessage = { role: "assistant", text, timestamp: textAt };
    if (reasoning.trim() !== "") message.reasoning = reasoning;
    stored.push(message);
    text = "";
    reasoning = "";
  };

  const markInterrupted = () => {
    flush();
    const last = stored.at(-1);
    if (last?.role === "assistant" && last.display_kind === undefined) {
      last.display_metadata = { interrupted: true };
    } else {
      stored.push({ role: "assistant", text: "", timestamp: at, display_metadata: { interrupted: true } });
    }
  };

  /** When the summary of a compaction came, until its place is marked. */
  let compactedAt: number | null = null;
  const markCompaction = (trigger: CompactionTrigger) => {
    if (compactedAt === null) return;
    flush();
    stored.push({ role: "compaction", trigger, timestamp: compactedAt });
    compactedAt = null;
  };
  /** The entry before was the `/compact` of a compaction, whose "Compacted" may come next. */
  let afterCompact = false;
  /**
   * What each turn spent (feature turn_usage): every request's usage once (Claude Code
   * stores a request's blocks one entry each, with the same id and usage), as its
   * result's `usage` adds them up live. Its subagents' are in files of their own.
   */
  const spent = new TurnTokens();
  const counted = new Set<string>();

  for (const raw of messages) {
    const entry = raw as Message;
    if (!entry || entry.parent_tool_use_id) continue;
    at = seconds(entry.timestamp, at);
    const content = entry.message?.content;
    const followsCompact = afterCompact;
    afterCompact = false;

    if (entry.type === "user" && entry.isCompactSummary === true) {
      flush();
      compactedAt = at;
      continue;
    }
    if (entry.type === "assistant") {
      const request = entry.message?.id;
      if (typeof request !== "string" || !counted.has(request)) {
        if (typeof request === "string") counted.add(request);
        spent.add(claudeTokens(entry.message?.usage));
      }
      // Compacted by Claude Code itself, as the context filled up: no command asked.
      markCompaction("auto");
      for (const block of Array.isArray(content) ? (content as Message[]) : []) {
        if (block?.type === "text" && typeof block.text === "string" && block.text !== "") {
          if (text === "" && reasoning === "") textAt = at;
          text = text === "" ? block.text : `${text}\n\n${block.text}`;
          textAt = at;
        } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") {
          if (text === "" && reasoning === "") textAt = at;
          reasoning = reasoning === "" ? block.thinking : `${reasoning}\n\n${block.thinking}`;
        } else if (block?.type === "tool_use" && typeof block.id === "string") {
          flush();
          tools.set(block.id, { name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
        }
      }
      continue;
    }
    if (entry.type !== "user") continue;

    const blocks = Array.isArray(content) ? (content as Message[]) : [];
    const results = blocks.filter((block) => block?.type === "tool_result");
    if (results.length > 0) markCompaction("auto");
    for (const block of results) {
      const call = tools.get(block.tool_use_id);
      if (!call) continue;
      flush();
      const outcome = { content: block.content, isError: block.is_error === true };
      // A task tool's call is a to-do row with the whole list, as it was live.
      const todo = todos.finished(call.name, call.input, outcome);
      const tool = todo?.tool ?? gatewayTool(call.name, call.input);
      const result = todo?.result ?? gatewayResult(call.name, call.input, outcome, cwd);
      const message: StoredMessage = {
        role: "tool",
        name: tool.name,
        args: tool.args,
        content: JSON.stringify(result),
        tool_call_id: block.tool_use_id,
        timestamp: at,
      };
      if (tool.context) message.context = tool.context;
      stored.push(message);
    }
    if (results.length > 0) continue;

    const said = typeof content === "string" ? content : blocks.map((block) => (block?.type === "text" ? block.text : "")).join("");
    if (said.trim().startsWith(interruptedMarker)) {
      markCompaction("auto");
      markInterrupted();
      continue;
    }
    const output = commandOutput(content);
    if (output) {
      if (followsCompact) continue;
      markCompaction("auto");
      flush();
      stored.push({ role: "assistant", text: output, timestamp: at });
      continue;
    }
    const ends = notified(said);
    if (ends.length > 0) {
      markCompaction("auto");
      flush();
      const note = noteFor(ends);
      spent.close(stored);
      stored.push({ role: "user", text: note.text, timestamp: at, display_kind: note.kind, display_metadata: { display_text: note.text } });
      continue;
    }
    const user = userText(content);
    if (user === null) continue;
    if (/^\/compact(\s|$)/.test(user)) {
      // The command, then the place it compacted, or that it did not.
      flush();
      spent.close(stored);
      stored.push({ role: "user", text: user, timestamp: at });
      if (compactedAt === null) {
        stored.push({ role: "assistant", text: notCompacted, timestamp: at, display_kind: "failed_turn" });
        continue;
      }
      markCompaction("manual");
      afterCompact = true;
      continue;
    }
    markCompaction("auto");
    flush();
    spent.close(stored);
    stored.push({ role: "user", text: user, timestamp: at });
  }
  markCompaction("auto");
  flush();
  spent.close(stored);
  return stored;
}

/**
 * Whether a session's last turn was cut off mid-way rather than ended (recovery-8): Claude
 * Code stores each answer of the model with its `stop_reason` once the answer is whole
 * (`end_turn`, `tool_use`, … ; 2.1.299 and the sessions on the mini before it never left
 * one null), a tool's result as the user's, and a Stop as its interrupted mark. A turn
 * that ended has the model's last answer, one that did not call a tool, at its end (or a
 * local command's output, or the mark). Cut off: its last entry is an answer that called
 * a tool (the call never ran), a tool's result (the model never answered it), or the
 * message that opened the turn or one steered into it, a command the model answers (a
 * skill's) or what Claude Code wrote as background work ended (nothing answered it). Anything
 * else counts as ended, as before: a turn the bridge recorded running is then told as
 * finished with its last reply.
 */
export function turnCutOff(messages: readonly unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index] as Message;
    if (!entry || entry.parent_tool_use_id) continue;
    if (entry.type === "assistant") return entry.message?.stop_reason === "tool_use";
    if (entry.type !== "user") continue;
    if (entry.isCompactSummary === true) return false;
    const content = entry.message?.content;
    const blocks = Array.isArray(content) ? (content as Message[]) : [];
    if (blocks.some((block) => block?.type === "tool_result")) return true;
    const said = typeof content === "string" ? content : blocks.map((block) => (block?.type === "text" ? block.text : "")).join("");
    if (said.trim().startsWith(interruptedMarker) || commandOutput(content) !== null) return false;
    // What Claude Code wrote as background work ended opens a turn of its own, which the
    // model answers.
    if (notified(said).length > 0) return true;
    const user = userText(content);
    if (user === null) continue;
    // A `/compact` ends its turn without an answer (its summary, or none when it failed); a
    // local command with its output, above. Any other command (a skill) the model answers.
    return !/^\/compact(\s|$)/.test(user);
  }
  return false;
}
