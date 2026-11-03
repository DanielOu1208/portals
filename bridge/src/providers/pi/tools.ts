import { isAbsolute, relative } from "node:path";
import { addedDiff, replacementDiff } from "../claude/tools.ts";

// Pi's tools as the app shows them: each becomes one of the gateway's tool names with the
// args and result shapes the app's tool rows read (docs/gateway-protocol.md, section 9),
// so a `bash` call is a Terminal row with its output and an `edit` an Edit row with its
// diff. Used for live turns and for history alike. History has a tool's arguments, the
// text it returned and its `details`; a live result also has `structuredContent`.

export interface GatewayTool {
  name: string;
  args: Record<string, unknown>;
  /** A label for tools whose args make none. */
  context?: string;
}

/** What a tool call returned, as far as it is known. */
export interface ToolOutcome {
  /** The result's content: text and image blocks. */
  content: unknown;
  isError: boolean;
  /** False when Pi gave no `durationMs`: the call ended without the tool running. */
  ran: boolean;
  /** Tool specific; an `edit`'s has its patch. */
  details?: unknown;
  /** `structuredContent`; only live results have it. */
  structured?: unknown;
}

/** The result of a tool that never reported back: its turn was stopped, or Pi died. */
export const stoppedResult = { status: "error", error: "Stopped before it finished." };

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Copies the keys of `input` that are set, under new names. Pi sends an argument the model left out as null. */
function pick(input: Record<string, unknown>, keys: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(keys)) {
    if (input[from] !== undefined && input[from] !== null && input[from] !== "") out[to] = input[from];
  }
  return out;
}

/** `input` without the arguments the model left out. */
function given(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

/** An `edit`'s replacements, `{oldText, newText}` each. */
function editsOf(input: Record<string, unknown>): { oldText: string; newText: string }[] {
  const edits = Array.isArray(input.edits) ? input.edits : [];
  return edits.flatMap((entry) => {
    const edit = record(entry);
    return edit ? [{ oldText: text(edit.oldText) ?? "", newText: text(edit.newText) ?? "" }] : [];
  });
}

/** One string, or the strings of a list joined: the user's web tools take either. */
function oneOrMany(one: unknown, many: unknown): string | undefined {
  if (text(one)) return text(one);
  const list = Array.isArray(many) ? many.filter((entry): entry is string => typeof entry === "string" && entry !== "") : [];
  return list.length > 0 ? list.join(", ") : undefined;
}

/** A tool an MCP server gave Pi: `mcp__<server>__<tool>`. */
const mcpName = /^mcp__(.+?)__(.+)$/;

export function gatewayTool(name: string, input: Record<string, unknown>): GatewayTool {
  switch (name) {
    case "bash":
    case "powershell":
      return { name: "terminal", args: pick(input, { command: "command" }) };
    case "read":
      return { name: "read_file", args: pick(input, { path: "path", offset: "offset", limit: "limit" }) };
    case "write":
      return { name: "write_file", args: pick(input, { path: "path", content: "content" }) };
    case "edit": {
      // Only these keys, so the row shows the diff and no input (HermesToolDisplay.input).
      const edits = editsOf(input);
      const args = pick(input, { path: "path" });
      return { name: "patch", args: edits.length === 1 ? { ...args, old_string: edits[0].oldText, new_string: edits[0].newText } : args };
    }
    case "grep":
    case "find":
      // No `path`: the row's label is then the pattern, not the folder searched.
      return { name: "search_files", args: pick(input, { pattern: "pattern", glob: "glob", path: "in" }) };
    case "ls":
      return { name: "search_files", args: pick(input, { path: "path" }) };
    case "codemode":
      return { name: "execute_code", args: pick(input, { code: "code" }) };
    case "web_search": {
      const query = oneOrMany(input.query, input.queries);
      return { name: "web_search", args: query ? { query } : {} };
    }
    case "fetch_content": {
      const url = oneOrMany(input.url, input.urls);
      return { name: "web_extract", args: url ? { url } : {} };
    }
    case "subagent": {
      const args = pick(input, { task: "task", agent: "agent" });
      return { name: "delegate_task", args: Object.keys(args).length > 0 ? args : given(input) };
    }
    default: {
      const mcp = mcpName.exec(name);
      return mcp ? { name: mcp[2], args: given(input), context: mcp[1] } : { name, args: given(input) };
    }
  }
}

// MARK: Results

/** A result's content as text: its text blocks, images named. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let all = "";
  for (const block of content) {
    const entry = record(block);
    const part = entry?.type === "text" ? (text(entry.text) ?? "") : entry?.type === "image" ? "[image]" : "";
    if (part === "") continue;
    // A block that ends its own line needs no line break after it.
    all += all === "" || all.endsWith("\n") ? part : `\n${part}`;
  }
  return all;
}

/** What Pi's shell tools put after a command's output when it did not simply succeed. */
const exitedWith = /(?:^|\n\n)Command exited with code (-?\d+)$/;
const aborted = /(?:^|\n\n)Command aborted$/;
/** What a command that printed nothing reads as. */
const noOutput = "(no output)";
/** What Pi's other tools say when Stop ends them. */
const operationAborted = "Operation aborted";

/** Whether a tool result's text says Stop ended the tool. */
export function saysAborted(said: string): boolean {
  return said === operationAborted || aborted.test(said);
}

function shellResult(said: string, outcome: ToolOutcome): unknown {
  const stopped = outcome.isError ? aborted.exec(said) : null;
  if (stopped) {
    // Stop ended it. What it had printed is kept.
    const output = said.slice(0, stopped.index);
    return output === "" ? stoppedResult : { ...stoppedResult, output };
  }
  const exited = outcome.isError ? exitedWith.exec(said) : null;
  const printed = exited ? said.slice(0, exited.index) : said;
  const output = printed === noOutput ? "" : printed;
  if (!outcome.isError) return { output, exit_code: 0 };
  // The code is a field of a live result; history has only the text.
  const known = record(outcome.structured)?.exit_code;
  const code = typeof known === "number" ? known : exited ? Number(exited[1]) : 1;
  return { output, exit_code: code };
}

/** The result in the shape the app reads for the tool's gateway name. */
export function gatewayResult(name: string, input: Record<string, unknown>, outcome: ToolOutcome, cwd: string): unknown {
  const said = contentText(outcome.content);
  // Stop came while it ran, or while an extension was still asking about it.
  if (outcome.isError && said === operationAborted) return stoppedResult;
  // An extension refused it, its arguments were wrong, or Pi has no such tool: it did
  // not run, which is not a command that exited with code 1.
  if (outcome.isError && !outcome.ran) return { status: "blocked", error: said || "It did not run." };

  switch (name) {
    case "bash":
    case "powershell":
      return shellResult(said, outcome);
    case "read":
      return outcome.isError ? { error: said || "The file could not be read." } : { content: said };
    case "write": {
      if (outcome.isError) return { error: said || "The file could not be written." };
      // Pi says only that it wrote the file, and not whether the file is new.
      return { diff: addedDiff(text(input.path) ?? "", text(input.content) ?? "", cwd, false) };
    }
    case "edit": {
      if (outcome.isError) return { success: false, error: said || "The edit could not be made." };
      const path = text(input.path) ?? "";
      const patch = text(record(outcome.details)?.patch);
      return { success: true, diff: (patch && patchDiff(patch, path, cwd)) || editDiff(path, editsOf(input), cwd) };
    }
    default:
      return outcome.isError ? { error: said || "The tool failed." } : { output: said };
  }
}

// MARK: Diffs

/**
 * A path as a diff names it: relative to the thread's folder when inside it, else whole,
 * with its leading "/" (`a//etc/hosts`), so a file outside is not read as one inside
 * (a turn's diff, feature turn_diff, opens it by that path).
 */
function diffPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

/**
 * Pi's own patch of an edit (`--- hello.txt`, `+++ hello.txt`, then the hunks) with its
 * two header lines as the other agents' diffs have them: `a/<path>` and `b/<path>`.
 * Null when it is no unified diff.
 */
function patchDiff(patch: string, path: string, cwd: string): string | null {
  const lines = patch.split("\n");
  const header = lines.findIndex((line, index) => line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ "));
  if (header < 0) return null;
  const name = diffPath(path, cwd);
  const rest = lines.slice(header + 2);
  if (rest.at(-1) === "") rest.pop();
  return [`--- a/${name}`, `+++ b/${name}`, ...rest].join("\n") + "\n";
}

/** An edit's diff from its replacements alone, without line numbers. */
function editDiff(path: string, edits: { oldText: string; newText: string }[], cwd: string): string {
  const name = diffPath(path, cwd);
  const parts = edits.map((edit) => replacementDiff(path, edit.oldText, edit.newText, cwd).split("\n").slice(2).join("\n").replace(/\n$/, ""));
  return [`--- a/${name}`, `+++ b/${name}`, ...parts.filter((part) => part !== "")].join("\n") + "\n";
}

// MARK: Errors

/** What Pi stores as the error of a model request that Stop cut off before it began. */
const abortErrors = new Set(["This operation was aborted", "Request was aborted", operationAborted]);

/**
 * Whether an assistant message's error is Stop's doing and not a failure. A turn stopped
 * while a command ran ends with an empty assistant message whose `stopReason` is
 * `error`, not `aborted`, and this as its `errorMessage`.
 */
export function isAbortError(errorMessage: string | undefined): boolean {
  return abortErrors.has(errorMessage ?? "");
}

const errorLength = 300;

/**
 * What a model's provider said went wrong, as a sentence to show. Pi passes it on raw,
 * JSON and all (`OpenAI API error (401): {"message":"Incorrect API key…","type":…}`):
 * the JSON is replaced by its message. OpenAI's API has that under `message` or
 * `error.message`; a ChatGPT sign-in has it under `detail`, with the status once more
 * before the JSON (`OpenAI API error (400): 400 {"detail":"The '…' model is not
 * supported…"}`), which is said once.
 */
export function errorText(raw: string): string {
  let said = raw.trim();
  const brace = said.indexOf("{");
  if (brace >= 0) {
    try {
      const body = record(JSON.parse(said.slice(brace)));
      const message = text(body?.message) ?? text(record(body?.error)?.message) ?? text(body?.detail);
      if (message) said = `${said.slice(0, brace).replace(/\((\d{3})\):\s*\1\s*$/, "($1): ")}${message}`.trim();
    } catch {
      // Not JSON after all: shown as it is.
    }
  }
  return said.length > errorLength ? `${said.slice(0, errorLength - 1).trimEnd()}…` : said;
}
