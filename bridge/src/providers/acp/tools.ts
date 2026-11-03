import { addedDiff, replacementDiff } from "../claude/tools.ts";
import { cutDiff } from "../../sessions/turnDiff.ts";
import { textDiff } from "./diff.ts";
import type { ContentBlock, PlanEntry, ToolCallContent, ToolCallFields } from "./protocol.ts";

// An agent's tool calls as the app shows them: each becomes one of the gateway's tool
// names with the args and result shapes the app's tool rows read
// (docs/gateway-protocol.md, section 9). The protocol says what kind of thing a call
// does (`execute`, `edit`, `read`, …) and gives it a title, some content and places;
// what the tool was given and what it returned come as the agent has them (`rawInput`,
// `rawOutput`), which differs from agent to agent, so those are read by the few keys
// agents commonly use and never relied on.

export interface GatewayTool {
  name: string;
  args: Record<string, unknown>;
  /** A label for tools whose args make none. */
  context?: string;
}

/** What is known to be odd about one agent's tool calls. */
export interface ToolQuirks {
  /**
   * Each side of a diff starts with what is left of a diff header line, and holds only
   * the changed lines, not the file (Cursor, for a file made new: `-- /dev/null`,
   * `++ b/path`).
   */
  diffHeaderScraps?: boolean;
  /** The agent's own tools, read before the protocol's kinds. */
  own?: OwnTools;
}

/**
 * What an agent's provider knows of the agent's own tools, where the protocol's kinds
 * do not say enough: a tool told only by what it was given, a call that failed but is
 * reported as completed. Each is asked first, and answers undefined to leave a call to
 * the kinds.
 */
export interface OwnTools {
  /** A call that gets no row: a card or a row of the provider's own stands for it. */
  hidden?(call: ToolCall): boolean;
  /** The row for a call. */
  tool?(call: ToolCall): GatewayTool | undefined;
  /** How a finished call went, in the shape the row's name takes. */
  result?(call: ToolCall, tool: GatewayTool): unknown;
  /**
   * What to say of a row the turn's end left open, in place of "Stopped before it
   * finished.". Not asked about a call the agent was still waiting for a yes to: that
   * one never ran.
   */
  stopped?(tool: GatewayTool): string | undefined;
}

/** What is known to be odd about one agent, and put right for it. The agent's provider says which. */
export interface Quirks extends ToolQuirks {
  /** A piece of reply that is not the agent's reply. */
  junkText?: RegExp;
}

type DiffBlock = { path?: string; oldText?: string | null; newText?: string };

/** A tool call as far as the agent has told: every update's fields laid over the ones before. */
export interface ToolCall extends ToolCallFields {
  /** The diffs last given. Kept apart: an agent may show the change when it asks, then only say "written". */
  diffs?: DiffBlock[];
}

const fields = ["title", "name", "kind", "status", "content", "locations", "rawInput", "rawOutput"] as const;

/** `known` with what `update` says. A field left out, or null, stays as it was. */
export function merged(known: ToolCall | undefined, update: ToolCallFields): ToolCall {
  const call: ToolCall = known ? { ...known } : { toolCallId: update.toolCallId };
  for (const key of fields) {
    const value = update[key];
    if (value !== undefined && value !== null) Object.assign(call, { [key]: value });
  }
  const diffs = (update.content ?? []).filter((block): block is ToolCallContent & DiffBlock => block?.type === "diff");
  if (diffs.length > 0) call.diffs = diffs;
  return call;
}

/** Whether the agent is done with it. */
export function isFinished(call: ToolCall): boolean {
  return call.status === "completed" || call.status === "failed";
}

/**
 * How much of one text is kept: a file written, a command's output, a diff. The app
 * shows 20 000 characters of each; the bridge keeps these threads' conversations
 * itself (the agent's provider does), and a build log is not worth megabytes there.
 */
const kept = 40_000;

function cut(value: string): string {
  return value.length > kept ? `${value.slice(0, kept)}\n…` : value;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A title without the backticks some agents put round a command or a path. */
function plain(title: string | null | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) return undefined;
  return /^`[^`]*`$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** The file a call is about: from its places, else from what the tool was given. */
function pathOf(call: ToolCall): string | undefined {
  const input = record(call.rawInput) ?? {};
  return (
    call.locations?.map((location) => text(location?.path)).find((path) => path !== undefined) ??
    text(input.path) ??
    text(input.filePath) ??
    text(input.file_path) ??
    call.diffs?.map((diff) => text(diff.path)).find((path) => path !== undefined)
  );
}

function commandOf(call: ToolCall): string | undefined {
  const command = record(call.rawInput)?.command;
  if (Array.isArray(command) && command.every((word) => typeof word === "string")) return command.join(" ");
  return text(command) ?? plain(call.title);
}

/** Only the keys that are set. */
function set(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

export function gatewayTool(call: ToolCall, own?: OwnTools): GatewayTool {
  const told = own?.tool?.(call);
  if (told) return told;
  const input = record(call.rawInput) ?? {};
  const title = plain(call.title);
  switch (call.kind) {
    case "execute":
      return { name: "terminal", args: set({ command: commandOf(call) }) };
    case "read":
      return withLabel({ name: "read_file", args: set({ path: pathOf(call) }) }, title);
    case "edit":
      // A whole file written, as the agent's tool took it: the row shows what was written.
      if (typeof input.content === "string" && pathOf(call)) return { name: "write_file", args: { path: pathOf(call), content: cut(input.content) } };
      // Only the path, so the row shows the diff and no input (HermesToolDisplay.input).
      return withLabel({ name: "patch", args: set({ path: pathOf(call) }) }, title);
    case "delete":
      return withLabel({ name: "delete_file", args: set({ path: pathOf(call) }) }, title);
    case "move":
      return withLabel({ name: "move_file", args: set({ path: pathOf(call) }) }, title);
    case "search":
      return { name: "search_files", args: { pattern: text(input.pattern) ?? text(input.query) ?? title ?? "" } };
    case "fetch":
      if (text(input.url)) return { name: "web_extract", args: { url: input.url } };
      if (text(input.query)) return { name: "web_search", args: { query: input.query } };
      return withLabel({ name: "web_extract", args: {} }, title);
    default:
      // The agent's own name for it, when it gives one; the title is the label either way.
      return { name: text(call.name) ?? "tool", args: input, ...(title ? { context: title } : {}) };
  }
}

/** The title as the label of a row whose args make none. */
function withLabel(tool: GatewayTool, title: string | undefined): GatewayTool {
  return Object.keys(tool.args).length === 0 && title ? { ...tool, context: title } : tool;
}

// MARK: Results

/** The text of a call's content, its other blocks named. */
export function contentText(content: ToolCallContent[] | null | undefined): string {
  return (content ?? [])
    .map((entry) => (entry?.type === "content" ? blockText((entry as { content?: ContentBlock }).content) : ""))
    .filter((part) => part !== "")
    .join("\n");
}

export function blockText(block: ContentBlock | undefined): string {
  if (!block) return "";
  if (block.type === "text") return typeof block.text === "string" ? block.text : "";
  if (block.type === "image") return "[image]";
  if (block.type === "resource_link") return text((block as { uri?: unknown }).uri) ?? "";
  return "";
}

/** What a command exited with, by the keys agents use; undefined when the agent does not say. */
function exitCode(output: Record<string, unknown> | undefined): number | undefined {
  const metadata = record(output?.metadata);
  return [output?.exitCode, output?.exit_code, metadata?.exit, metadata?.exitCode].find((value): value is number => typeof value === "number");
}

/** What the tool returned as text, when the call's content has none. */
function rawText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const output = record(raw);
  if (!output) return "";
  const streams = [text(output.stdout), text(output.stderr)].filter((part) => part !== undefined).join("\n");
  return streams || (text(output.output) ?? text(output.content) ?? text(output.text) ?? text(output.error) ?? "");
}

/** The diffs of a call as one unified diff; "" when the agent gave none. */
export function diffOf(call: ToolCall, cwd: string, quirks: ToolQuirks = {}): string {
  return (call.diffs ?? [])
    .map((diff) => {
      const path = text(diff.path) ?? pathOf(call) ?? "file";
      const after = diff.newText ?? "";
      if (quirks.diffHeaderScraps) {
        const scrapped = withoutScraps(diff.oldText ?? "", after);
        if (scrapped) return scrapped.created ? addedDiff(path, scrapped.after, cwd, true) : replacementDiff(path, scrapped.before, scrapped.after, cwd);
      }
      // No text before: a new file. An empty one: a file that was empty.
      if (diff.oldText === null || diff.oldText === undefined) return addedDiff(path, after, cwd, true);
      return textDiff(path, diff.oldText, after, cwd);
    })
    // Each file's kept apart to `kept`, saying what it left out: a long one cut as a whole
    // would take the files after it with it, and the turn's counts (feature turn_diff).
    .map((diff) => cutDiff(diff, kept))
    .join("");
}

/** The change a call made or wants to make: the agent's diffs, else what it wrote as lines added. */
function changeDiff(call: ToolCall, tool: GatewayTool, cwd: string, quirks: ToolQuirks): string {
  const path = text(tool.args.path);
  // What was written whole, as the agent gave it (the row's argument is cut short), so the
  // lines a turn's diff counts are all of them.
  const written = text(record(call.rawInput)?.content) ?? (typeof tool.args.content === "string" ? tool.args.content : undefined);
  return diffOf(call, cwd, quirks) || (path && written !== undefined ? cutDiff(addedDiff(path, written, cwd, false), kept) : "");
}

/** The two sides without the header scrap each starts with; null when they do not start so. */
function withoutScraps(before: string, after: string): { before: string; after: string; created: boolean } | null {
  const [oldHead, ...oldRest] = before.split("\n");
  const [newHead, ...newRest] = after.split("\n");
  if (!oldHead.startsWith("-- ") || !newHead.startsWith("++ ")) return null;
  return { before: oldRest.join("\n"), after: newRest.join("\n"), created: oldHead === "-- /dev/null" };
}

const deniedSummaries: Record<string, string> = {
  terminal: "You denied this command — it did not run.",
  patch: "You denied this change — it was not made.",
  write_file: "You denied this change — it was not made.",
};

/**
 * Why a call has no result of its own: the person said no to it; the turn ended while
 * the agent still waited for a yes to it (`held`), so it never ran; or the turn ended
 * while it ran.
 */
export type Unfinished = "denied" | "held" | "stopped";

/** The result in the shape the app reads for the tool's gateway name. */
export function gatewayResult(call: ToolCall, tool: GatewayTool, cwd: string, quirks: ToolQuirks = {}, unfinished?: Unfinished): unknown {
  const said = cut(contentText(call.content) || rawText(call.rawOutput));
  if (unfinished === "denied") {
    return { status: "blocked", error: said || "Denied from Portals.", user_summary: deniedSummaries[tool.name] ?? "You denied this — it did not run." };
  }
  if (unfinished === "held") return { status: "error", error: "Stopped before it finished." };
  if (unfinished === "stopped") return { status: "error", error: quirks.own?.stopped?.(tool) ?? "Stopped before it finished." };
  const told = quirks.own?.result?.(call, tool);
  if (told !== undefined) return told;
  const failed = call.status === "failed";
  // A tool that returned nothing has an empty result, which the app shows as nothing:
  // `{output: ""}` it would print as it is.
  const nothing = said === "" && !failed;
  switch (tool.name) {
    case "terminal":
      // A command that failed is said by its exit code; agents that give none say `failed`.
      return { output: said, exit_code: exitCode(record(call.rawOutput)) ?? (failed ? 1 : 0) };
    case "read_file":
      if (nothing) return {};
      return failed ? { error: said || "The file could not be read." } : { content: said };
    case "patch":
      return failed ? { success: false, error: said || "The edit failed." } : { success: true, diff: changeDiff(call, tool, cwd, quirks) };
    case "write_file":
      return failed ? { success: false, error: said || "The file could not be written." } : { diff: changeDiff(call, tool, cwd, quirks) };
    default:
      if (nothing) return {};
      return failed ? { error: said || "The tool failed." } : { output: said };
  }
}

// MARK: Approvals

/** What a tool wants to do, for an approval card: one line, plus the diff for an edit. */
export function approvalCommand(call: ToolCall, tool: GatewayTool, cwd: string, quirks: ToolQuirks = {}): string {
  const title = plain(call.title);
  switch (tool.name) {
    case "terminal":
      return text(tool.args.command) ?? "Run a command";
    case "patch":
    case "write_file": {
      const diff = changeDiff(call, tool, cwd, quirks);
      return `Edit ${text(tool.args.path) ?? "a file"}${diff ? `\n${diff}` : ""}`;
    }
    case "read_file":
      return `Read ${text(tool.args.path) ?? title ?? "a file"}`;
    case "delete_file":
      return `Delete ${text(tool.args.path) ?? title ?? "a file"}`;
    case "web_extract":
      return `Fetch ${text(tool.args.url) ?? title ?? "a page"}`;
    case "web_search":
      return `Search the web for ${text(tool.args.query) ?? "something"}`;
    default:
      return title ?? tool.name;
  }
}

// MARK: Plans

/** An agent's plan as a to-do row: the label says how far it is, the result lists it. */
export function planTool(entries: PlanEntry[]): { tool: GatewayTool; result: unknown } {
  const todos = entries.map((entry) => ({ content: entry.content ?? "", status: entry.status ?? "pending" }));
  const done = todos.filter((todo) => todo.status === "completed").length;
  const lines = todos.map((todo) => `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "→" : "○"} ${todo.content}`);
  return { tool: { name: "todo", args: { todos }, context: `${done} of ${todos.length} done` }, result: { output: lines.join("\n") } };
}
