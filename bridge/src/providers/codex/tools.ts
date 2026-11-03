import { asShown } from "../liveOutput.ts";
import { basename, isAbsolute, relative } from "node:path";
import type { FileUpdateChange, ThreadItem } from "./types/index.ts";

// Codex's work items as the app shows them: each becomes one of the gateway's tool
// names with the args and result shapes the app's tool rows read
// (docs/gateway-protocol.md, section 9), so a `commandExecution` is a Terminal row with
// its output and a `fileChange` an Edit (or Write) row with its diff. Used for live
// turns and for history alike: both have the whole item.

export interface GatewayTool {
  name: string;
  args: Record<string, unknown>;
  /** A label for tools whose args make none. */
  context?: string;
}

type Item = Record<string, any>;

/** The item types that are tool rows; the rest are text, reasoning or bookkeeping. */
const toolTypes = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall", "imageView", "imageGeneration", "plan"]);

export function isToolItem(item: ThreadItem | Item): boolean {
  return toolTypes.has((item as Item).type);
}

// MARK: Commands

/**
 * The words of a POSIX shell command line, unquoted; null when it has quoting this
 * reader does not follow (it is then shown as it is).
 */
function shellWords(line: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) return null;
      word += line.slice(index + 1, end);
      index = end;
      inWord = true;
    } else if (char === '"') {
      let end = index + 1;
      for (; end < line.length && line[end] !== '"'; end += 1) {
        if (line[end] === "\\" && end + 1 < line.length && '"\\$`\n'.includes(line[end + 1])) {
          word += line[end + 1];
          end += 1;
        } else {
          if (line[end] === "$" || line[end] === "`") return null;
          word += line[end];
        }
      }
      if (end >= line.length) return null;
      index = end;
      inWord = true;
    } else if (char === "\\") {
      if (index + 1 >= line.length) return null;
      word += line[index + 1];
      index += 1;
      inWord = true;
    } else if (char === " " || char === "\t" || char === "\n") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

const shells = new Set(["zsh", "bash", "sh"]);

/**
 * The command as the person typed it would read: Codex runs everything through a login
 * shell (`/bin/zsh -lc 'touch done.txt'`), which is left off.
 */
export function displayCommand(command: string): string {
  const words = shellWords(command.trim());
  if (words && words.length === 3 && shells.has(basename(words[0])) && /^-l?c$/.test(words[1])) return words[2];
  return command;
}

// MARK: Diffs

/** A path as a diff names it: relative to the thread's folder when inside it. */
function diffPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return inside;
  // Codex reports /tmp paths for a thread in /private/tmp, and the other way round.
  const other = path.startsWith("/private/") ? path.slice("/private".length) : `/private${path}`;
  const again = relative(cwd, other);
  if (again && !again.startsWith("..") && !isAbsolute(again)) return again;
  // Whole, with its leading "/" (`a//etc/hosts`): a file outside is not read as one inside.
  return path;
}

function lines(text: string): string[] {
  if (text === "") return [];
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Codex's diff of one change (only hunks for an update, the content for an add or delete) as a unified diff. */
export function changeDiff(change: FileUpdateChange, cwd: string): string {
  const name = diffPath(change.path, cwd);
  const text = change.diff ?? "";
  const kind = change.kind?.type;
  // Already a whole diff: kept as it is.
  if (text.startsWith("--- ")) return text.endsWith("\n") ? text : `${text}\n`;
  if (kind === "add" || kind === "delete") {
    if (text.startsWith("@@")) {
      const header = kind === "add" ? ["--- /dev/null", `+++ b/${name}`] : [`--- a/${name}`, "+++ /dev/null"];
      return [...header, ...lines(text)].join("\n") + "\n";
    }
    const content = lines(text);
    if (kind === "add") {
      const hunk = content.length > 0 ? [`@@ -0,0 +${range(1, content.length)} @@`] : [];
      return ["--- /dev/null", `+++ b/${name}`, ...hunk, ...content.map((line) => `+${line}`)].join("\n") + "\n";
    }
    const hunk = content.length > 0 ? [`@@ -${range(1, content.length)} +0,0 @@`] : [];
    return [`--- a/${name}`, "+++ /dev/null", ...hunk, ...content.map((line) => `-${line}`)].join("\n") + "\n";
  }
  const moved = change.kind?.type === "update" && change.kind.move_path ? diffPath(change.kind.move_path, cwd) : name;
  return [`--- a/${name}`, `+++ b/${moved}`, ...lines(text)].join("\n") + "\n";
}

/** Every change of a fileChange item as one unified diff. */
export function fileChangeDiff(changes: readonly FileUpdateChange[], cwd: string): string {
  return changes.map((change) => changeDiff(change, cwd)).join("");
}

function onlyAdds(changes: readonly FileUpdateChange[]): boolean {
  return changes.length > 0 && changes.every((change) => change.kind?.type === "add");
}

// MARK: Rows

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The row a tool item makes; null for an item that is not a tool. `agents`: for a call
 * about the thread's sub-agents other than a spawn, the names of those it was about
 * (`CodexAgents.calledAbout`), which its row carries (feature `subagent_calls`).
 */
export function gatewayTool(raw: ThreadItem | Item, agents?: readonly string[]): GatewayTool | null {
  const item = raw as Item;
  switch (item.type) {
    case "commandExecution":
      return { name: "terminal", args: { command: displayCommand(text(item.command) ?? "") } };
    case "fileChange": {
      const changes: FileUpdateChange[] = Array.isArray(item.changes) ? item.changes : [];
      const first = changes[0];
      const path = first?.path ?? "";
      if (onlyAdds(changes)) {
        // One new file shows its content as the row's input; several only their diff.
        return { name: "write_file", args: changes.length === 1 ? { path, content: first.diff ?? "" } : { path } };
      }
      return { name: "patch", args: path ? { path } : {} };
    }
    case "mcpToolCall":
      return { name: text(item.tool) ?? "mcp", args: object(item.arguments), context: text(item.server) };
    case "dynamicToolCall":
      return { name: text(item.tool) ?? "tool", args: object(item.arguments), context: text(item.namespace) ?? undefined };
    case "webSearch": {
      const action = object(item.action);
      if (action.type === "open_page" || action.type === "find_in_page") {
        const args: Record<string, unknown> = {};
        if (text(action.url)) args.url = action.url;
        if (text(action.pattern)) args.pattern = action.pattern;
        return { name: "web_extract", args };
      }
      const query = text(item.query) || text(action.query) || (Array.isArray(action.queries) ? action.queries.filter((entry) => typeof entry === "string").join(", ") : "");
      return { name: "web_search", args: query ? { query } : {} };
    }
    case "collabAgentToolCall": {
      // A spawn carries its task; any other call (a wait, a close, a message) who it was
      // about. The tool's name is still the label an app without the feature shows.
      const args: Record<string, unknown> = {};
      if (text(item.prompt)) args.task = item.prompt;
      if (text(item.model)) args.agent = item.model;
      if (item.tool !== "spawnAgent" && agents) args.agents = [...agents];
      return { name: "delegate_task", args, context: text(item.tool) };
    }
    case "imageView":
      return { name: "vision_analyze", args: { path: text(item.path) ?? "" } };
    case "imageGeneration":
      return { name: "image_generate", args: text(item.revisedPrompt) ? { prompt: item.revisedPrompt } : {} };
    case "plan":
      // No label: the row is called Plan already ("Plan Plan").
      return { name: "plan", args: { content: text(item.text) ?? "" } };
    default:
      return null;
  }
}

const deniedSummaries: Record<string, string> = {
  terminal: "You denied this command — it did not run.",
  patch: "You denied this change — it was not made.",
  write_file: "You denied this change — it was not made.",
};

/** What the bridge tells the app about a declined item. */
export const declinedText = "Declined.";

/** A finished tool item's result, in the shape the app reads for its gateway name. */
export function gatewayResult(raw: ThreadItem | Item, cwd: string): unknown {
  const item = raw as Item;
  const tool = gatewayTool(item);
  const status = text(item.status);
  if (status === "declined") {
    return { status: "blocked", error: declinedText, user_summary: deniedSummaries[tool?.name ?? ""] ?? "You denied this — it did not run." };
  }
  switch (item.type) {
    case "commandExecution": {
      // A command run in a terminal (a background one) ends its lines with `\r\n`, which
      // the app would show as blank lines between them.
      const output = asShown(text(item.aggregatedOutput) ?? "");
      const code = typeof item.exitCode === "number" ? item.exitCode : status === "failed" ? 1 : 0;
      return { output, exit_code: code };
    }
    case "fileChange": {
      const changes: FileUpdateChange[] = Array.isArray(item.changes) ? item.changes : [];
      if (status === "failed") return { success: false, error: "Codex could not apply this change.", diff: fileChangeDiff(changes, cwd) };
      if (tool?.name === "write_file") return { diff: fileChangeDiff(changes, cwd) };
      return { success: true, diff: fileChangeDiff(changes, cwd) };
    }
    case "mcpToolCall": {
      if (item.error) return { error: text(object(item.error).message) ?? "The tool failed." };
      const result = object(item.result);
      const said = contentText(result.content);
      if (said) return { output: said };
      return result.structuredContent !== undefined && result.structuredContent !== null ? { output: JSON.stringify(result.structuredContent, null, 2) } : { output: "Done." };
    }
    case "dynamicToolCall": {
      const said = contentText(item.contentItems);
      if (item.success === false || status === "failed") return { error: said || "The tool failed." };
      return { output: said || "Done." };
    }
    case "webSearch":
      return { output: searchResults(item.results) };
    case "collabAgentToolCall": {
      const states = Object.values(object(item.agentsStates)).map((state) => object(state));
      const said = states.map((state) => text(state.message) ?? "").filter((message) => message !== "").join("\n\n");
      if (status === "failed") return { error: said || "The agent failed." };
      return { output: said || (status === "interrupted" ? "Stopped." : "Done.") };
    }
    case "imageView":
      return { output: "Looked at the image." };
    case "imageGeneration":
      if (item.failure) return { error: "The image could not be made." };
      return { output: text(item.savedPath) ? `Saved to ${item.savedPath}` : "Made an image." };
    case "plan":
      return { output: "Codex proposed this plan." };
    default:
      return { output: "" };
  }
}

/** The text of MCP or dynamic tool content: its text items, others named. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      const block = object(entry);
      if (block.type === "text" || block.type === "inputText") return text(block.text) ?? "";
      if (block.type === "image" || block.type === "inputImage") return "[image]";
      return "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

function searchResults(results: unknown): string {
  if (!Array.isArray(results) || results.length === 0) return "Searched the web.";
  const found = results
    .map((entry) => {
      const result = object(entry);
      const title = text(result.title);
      const url = text(result.url);
      return [title, url].filter((part) => part).join(" — ");
    })
    .filter((line) => line !== "");
  return found.length > 0 ? found.join("\n") : "Searched the web.";
}

// MARK: Approvals

/** The approval card's text for a file change: "Edit <path>" and its diff. */
export function changeApprovalText(changes: readonly FileUpdateChange[], cwd: string): string {
  if (changes.length === 0) return "Edit files";
  const paths = changes.map((change) => change.path).join(", ");
  return `Edit ${paths}\n${fileChangeDiff(changes, cwd)}`;
}
