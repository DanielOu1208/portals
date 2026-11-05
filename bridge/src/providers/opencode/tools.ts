import { addedDiff, replacementDiff } from "../claude/tools.ts";
import { cutDiff } from "../../sessions/turnDiff.ts";
import type { Json, PermissionRequest, StructuredError, ToolContent } from "./protocol.ts";

// OpenCode's tool calls as the app shows them: each becomes one of the gateway's tool
// names, with the args and result shapes the app's tool rows read
// (docs/gateway-protocol.md, section 9). OpenCode names its tools (`shell`, `write`,
// `edit`, …) and gives what each was given as an object; the keys are read by the
// names OpenCode 2.2.5 uses, and by the usual others, and never relied on.

export interface GatewayTool {
  name: string;
  args: Record<string, unknown>;
  /** A label for tools whose args make none. */
  context?: string;
}

/** How much of one text is kept: the app shows 20 000 characters of each. */
const kept = 40_000;

function cut(value: string): string {
  return value.length > kept ? `${value.slice(0, kept)}\n…` : value;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

/** Only the keys that are set. */
function set(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

function pathOf(input: Json): string | undefined {
  return text(input.path) ?? text(input.filePath) ?? text(input.file_path);
}

export function gatewayTool(name: string, input: Json): GatewayTool {
  const description = text(input.description);
  switch (name) {
    case "todowrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const done = todos.filter((todo) => record(todo)?.status === "completed").length;
      return { name: "todo", args: { todos }, context: `${done} of ${todos.length} done` };
    }
    case "shell":
    case "bash":
      return { name: "terminal", args: set({ command: text(input.command) }), ...(description ? { context: description } : {}) };
    case "read":
      return { name: "read_file", args: set({ path: pathOf(input) }) };
    case "write":
      return { name: "write_file", args: set({ path: pathOf(input), content: typeof input.content === "string" ? cut(input.content) : undefined }) };
    case "edit":
    case "patch":
    case "multiedit":
      // Only the path: the row shows the diff, not the input (HermesToolDisplay.input).
      return { name: "patch", args: set({ path: pathOf(input) }) };
    case "glob":
    case "grep":
      return { name: "search_files", args: { pattern: text(input.pattern) ?? text(input.query) ?? "" } };
    case "webfetch":
      return { name: "web_extract", args: set({ url: text(input.url) }) };
    case "websearch":
      return { name: "web_search", args: set({ query: text(input.query) }) };
    case "subagent":
    case "task":
      return { name: "delegate_task", args: set({ task: text(input.prompt), agent: text(input.agent) ?? text(input.subagent_type) }), ...(description ? { context: description } : {}) };
    default:
      return { name, args: input };
  }
}

/** The text of what a tool returned, its files named. */
export function contentText(content: ToolContent[] | undefined): string {
  return (content ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : part.type === "file" ? `[${part.name ?? part.uri ?? "file"}]` : ""))
    .filter((part) => part !== "")
    .join("\n");
}

const deniedSummaries: Record<string, string> = {
  terminal: "You denied this command — it did not run.",
  patch: "You denied this change — it was not made.",
  write_file: "You denied this change — it was not made.",
};

/** The diffs OpenCode gives of an edit, by the keys it uses: its permission ask's `files[].patch`, or `diff`. */
function givenDiff(metadata: Json | undefined): string {
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const patches = files.map((file) => text(record(file)?.patch)).filter((patch): patch is string => patch !== undefined);
  return unified(patches.length > 0 ? patches.join("") : (text(metadata?.diff) ?? ""));
}

/**
 * OpenCode's patches (`Index: x`, a line of `=`, `--- x`, `+++ x`) as the unified diffs
 * the bridge's other agents give (`--- a/x`, `+++ b/x`), which the app reads.
 */
export function unified(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => !line.startsWith("Index: ") && !/^={10,}$/.test(line))
    .map((line) => line.replace(/^--- (?!a\/|\/dev\/null)/, "--- a/").replace(/^\+\+\+ (?!b\/|\/dev\/null)/, "+++ b/"))
    .join("\n");
}

/** What an edit changed: OpenCode's diff, else one made from what the tool was given. */
export function editDiff(name: string, input: Json, metadata: Json | undefined, cwd: string): string {
  const given = givenDiff(metadata);
  if (given) return cutDiff(given, kept);
  const path = pathOf(input);
  if (!path) return "";
  if (name === "write" && typeof input.content === "string") return cutDiff(addedDiff(path, input.content, cwd, false), kept);
  const before = text(input.oldString) ?? text(input.old_string);
  const after = typeof input.newString === "string" ? input.newString : typeof input.new_string === "string" ? input.new_string : undefined;
  return before !== undefined && after !== undefined ? cutDiff(replacementDiff(path, before, after, cwd), kept) : "";
}

export type ToolOutcome =
  | { ok: true; content: ToolContent[]; metadata?: Json }
  | { ok: false; error: StructuredError; content?: ToolContent[]; metadata?: Json }
  /** The turn ended while it ran. */
  | { ok: "stopped" };

/** The result in the shape the app reads for the tool's gateway name. */
export function gatewayResult(name: string, input: Json, tool: GatewayTool, outcome: ToolOutcome, cwd: string): unknown {
  if (outcome.ok === "stopped") return { status: "error", error: "Stopped before it finished." };
  if (!outcome.ok && outcome.error.type === "permission.rejected") {
    return { status: "blocked", error: outcome.error.message || "Denied from Portals.", user_summary: deniedSummaries[tool.name] ?? "You denied this — it did not run." };
  }
  const said = cut(contentText(outcome.content));
  const failed = !outcome.ok;
  const error = failed ? outcome.error.message || said : "";
  switch (tool.name) {
    case "todo":
      if (failed) return { error: error || "The task list was not changed." };
      return { output: (Array.isArray(input.todos) ? input.todos : []).map((todo) => {
        const entry = record(todo);
        const mark = entry?.status === "completed" ? "✓" : entry?.status === "in_progress" ? "→" : "○";
        return `${mark} ${text(entry?.content) ?? ""}`;
      }).join("\n") };
    case "terminal": {
      const exit = outcome.metadata?.exit;
      return failed && said === "" ? { output: error, exit_code: typeof exit === "number" ? exit : 1 } : { output: said, exit_code: typeof exit === "number" ? exit : failed ? 1 : 0 };
    }
    case "read_file":
      if (failed) return { error: error || "The file could not be read." };
      return said === "" ? {} : { content: said };
    case "patch":
      return failed ? { success: false, error: error || "The edit failed." } : { success: true, diff: editDiff(name, input, outcome.metadata, cwd) };
    case "write_file":
      return failed ? { success: false, error: error || "The file could not be written." } : { diff: editDiff(name, input, outcome.metadata, cwd) };
    default:
      if (failed) return { error: error || "The tool failed." };
      return said === "" ? {} : { output: said };
  }
}

/** What a permission ask wants to do, for the approval card: one line, plus the diff for an edit. */
export function approvalCommand(request: PermissionRequest): string {
  const resources = request.resources.join("\n");
  switch (request.action) {
    case "shell":
      return resources || "Run a command";
    case "edit": {
      const diff = givenDiff(request.metadata);
      return `Edit ${request.resources.join(", ") || "a file"}${diff ? `\n${diff}` : ""}`;
    }
    case "read":
      return `Read ${resources || "a file"}`;
    case "webfetch":
      return `Fetch ${resources || "a page"}`;
    case "websearch":
      return `Search the web for ${resources || "something"}`;
    case "external_directory":
      return `Use files outside the project: ${request.resources.join(", ")}`;
    case "subagent":
      return `Start the ${resources || "a"} subagent`;
    default:
      return resources ? `${request.action}: ${request.resources.join(", ")}` : request.action;
  }
}

/** What the card says OpenCode asks, a line. */
export function approvalDescription(request: PermissionRequest): string {
  switch (request.action) {
    case "shell":
      return "OpenCode wants to run this command";
    case "edit":
      return "OpenCode wants to make this change";
    default:
      return "OpenCode wants permission for this";
  }
}
