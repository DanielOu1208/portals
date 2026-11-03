import { isAbsolute, relative } from "node:path";
import { cutWhole } from "../../json.ts";

// Claude Code's tools as the app shows them: each becomes one of the gateway's tool
// names with the args and result shapes the app's tool rows read
// (docs/gateway-protocol.md, section 9), so a Bash call is a Terminal row with its
// output and an Edit is an Edit row with its diff. Used for live turns and for history
// alike; history has only the tool's input and the text it returned, live turns also
// have Claude's structured result (`tool_use_result`), whose exact diffs the bridge keeps
// for history (`historyLosesDiff`).

export interface GatewayTool {
  name: string;
  args: Record<string, unknown>;
  /** A label for tools whose args make none. */
  context?: string;
}

/** What a tool call returned, as far as it is known. */
export interface ToolOutcome {
  /** The tool_result content: text, or content blocks. */
  content: unknown;
  isError: boolean;
  /** Claude's structured result; only live turns have it. */
  structured?: unknown;
  /** The person on the phone said no. */
  denied?: boolean;
}

/** What the bridge answers Claude when the phone says no. */
export const denialMessage = "Denied from Portals.";
/** The same answer as stored in sessions from before the app was called Portals. */
const earlierDenialMessages = ["Denied from AeriPortal."];

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Copies the keys of `input` that are set, under new names. */
function pick(input: Record<string, unknown>, keys: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(keys)) {
    if (input[from] !== undefined && input[from] !== null && input[from] !== "") out[to] = input[from];
  }
  return out;
}

export function gatewayTool(name: string, input: Record<string, unknown>): GatewayTool {
  switch (name) {
    case "Bash":
      return { name: "terminal", args: pick(input, { command: "command" }) };
    case "Read":
      return { name: "read_file", args: pick(input, { file_path: "path", offset: "offset", limit: "limit" }) };
    case "Write":
      return { name: "write_file", args: pick(input, { file_path: "path", content: "content" }) };
    case "Edit":
      // Only these keys, so the row shows the diff and no input (HermesToolDisplay.input).
      return { name: "patch", args: pick(input, { file_path: "path", old_string: "old_string", new_string: "new_string" }) };
    case "MultiEdit":
      return { name: "patch", args: pick(input, { file_path: "path" }) };
    case "Grep":
      // No `path`: the row's label is then the pattern, not the folder searched.
      return { name: "search_files", args: pick(input, { pattern: "pattern", glob: "glob", type: "type", path: "in" }) };
    case "Glob":
      return { name: "search_files", args: pick(input, { pattern: "pattern", path: "in" }) };
    case "WebSearch":
      return { name: "web_search", args: pick(input, { query: "query" }) };
    case "WebFetch":
      return { name: "web_extract", args: pick(input, { url: "url", prompt: "prompt" }) };
    case "Task":
    case "Agent": {
      // The label is the short description; the prompt is the input shown.
      const description = text(input.description);
      return { name: "delegate_task", args: pick(input, { prompt: "task", subagent_type: "agent" }), context: description };
    }
    case "TodoWrite":
      return { name: "todo", args: { todos: input.todos ?? [] }, context: todoLabel(input.todos) };
    case "AskUserQuestion":
      // The app shows the question as a card of its own and skips this row.
      return { name: "clarify", args: { questions: questionsOf(input).map((question) => ({ question: question.question, choices: question.labels })) } };
    case "ExitPlanMode":
      // No label: the row is called Plan already, which a label of "Plan" said again ("Plan Plan").
      return { name: "plan", args: pick(input, { plan: "content" }) };
    default:
      return { name, args: input };
  }
}

export interface Question {
  question: string;
  labels: string[];
  multiSelect: boolean;
  /** Claude's short name for the question ("Auth method"). */
  header?: string;
  /** What each label means, by label, where Claude says. */
  descriptions: Record<string, string>;
}

/** The questions of an AskUserQuestion call. */
export function questionsOf(input: Record<string, unknown>): Question[] {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions.flatMap((entry) => {
    const question = record(entry);
    const asked = text(question?.question);
    if (!question || !asked) return [];
    const options = Array.isArray(question.options) ? question.options : [];
    const labels: string[] = [];
    const descriptions: Record<string, string> = {};
    for (const option of options) {
      const label = text(record(option)?.label);
      if (!label) continue;
      labels.push(label);
      const description = text(record(option)?.description);
      if (description) descriptions[label] = description;
    }
    const header = text(question.header);
    return [{ question: asked, labels, multiSelect: question.multiSelect === true, ...(header ? { header } : {}), descriptions }];
  });
}

function todoLabel(todos: unknown): string | undefined {
  if (!Array.isArray(todos)) return undefined;
  const done = todos.filter((todo) => record(todo)?.status === "completed").length;
  return `${done} of ${todos.length} done`;
}

// MARK: Results

/** A tool_result's content as text: its text blocks, other blocks named. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const entry = record(block);
      if (entry?.type === "text") return text(entry.text) ?? "";
      if (entry?.type === "image") return "[image]";
      if (entry?.type === "tool_reference" && typeof entry.tool_name === "string") return entry.tool_name;
      return "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

const deniedSummaries: Record<string, string> = {
  terminal: "You denied this command — it did not run.",
  patch: "You denied this change — it was not made.",
  write_file: "You denied this change — it was not made.",
  plan: "You asked Claude to keep planning.",
};

/** The result in the shape the app reads for the tool's gateway name. */
export function gatewayResult(name: string, input: Record<string, unknown>, outcome: ToolOutcome, cwd: string): unknown {
  const said = contentText(outcome.content);
  const structured = record(outcome.structured);
  const gateway = gatewayTool(name, input).name;
  if (outcome.denied || (outcome.isError && [denialMessage, ...earlierDenialMessages].some((message) => said.includes(message)))) {
    return { status: "blocked", error: said || denialMessage, user_summary: deniedSummaries[gateway] ?? "You denied this — it did not run." };
  }

  switch (name) {
    case "Bash": {
      // A command sent to the background has no output yet; Claude's text says so.
      const output = structured && !structured.backgroundTaskId
        ? [text(structured.stdout), text(structured.stderr)].filter((part) => part).join("\n")
        : said;
      // Claude reports a failed command as an error whose text starts with its exit code.
      const code = outcome.isError ? Number(/^Exit code (\d+)/.exec(said)?.[1] ?? 1) : 0;
      return { output: output || (outcome.isError ? said : ""), exit_code: code };
    }
    case "Read": {
      if (outcome.isError) return { error: said };
      const file = record(structured?.file);
      return { content: text(file?.content) ?? withoutLineNumbers(said) };
    }
    case "Edit":
    case "MultiEdit": {
      if (outcome.isError) return { success: false, error: said };
      const path = text(input.file_path) ?? "";
      const hunks = Array.isArray(structured?.structuredPatch) ? (structured.structuredPatch as Hunk[]) : null;
      const diff = hunks && hunks.length > 0 ? unifiedDiff(path, hunks, cwd) : editDiff(name, input, cwd);
      return { success: true, diff };
    }
    case "Write": {
      if (outcome.isError) return { success: false, error: said };
      const path = text(input.file_path) ?? "";
      const hunks = Array.isArray(structured?.structuredPatch) ? (structured.structuredPatch as Hunk[]) : [];
      // From history, which keeps no structured result, Claude's own words say a file was new.
      const created = structured ? structured.type === "create" : /^File created successfully/.test(said);
      const diff = hunks.length > 0 ? unifiedDiff(path, hunks, cwd) : addedDiff(path, text(input.content) ?? "", cwd, created);
      return { diff };
    }
    case "TodoWrite":
      return { output: todoText(input.todos) };
    case "AskUserQuestion":
      return { responses: answersOf(input, structured, said) };
    case "ExitPlanMode":
      return outcome.isError ? { error: said } : { output: "Plan approved." };
    case "WebFetch":
      return outcome.isError ? { error: said } : { content: said };
    default:
      return outcome.isError ? { error: said || "The tool failed." } : { output: said };
  }
}

/**
 * Whether the diff of a live edit's result (`result`, from `outcome` with Claude's
 * structured result) is one Claude's history will not give back: history keeps no
 * structured patch, so the same edit read back from it has another diff (an Edit's
 * without line numbers, and with one replacement where `replace_all` made several; a
 * Write over a file's without the lines it replaced). The bridge keeps such a diff
 * (`keepDiff`, src/sessions/keptDiffs.ts). False for any other tool, and for an edit
 * history gives back the same (a new file written whole).
 */
export function historyLosesDiff(name: string, input: Record<string, unknown>, outcome: ToolOutcome, result: unknown, cwd: string): boolean {
  if ((name !== "Edit" && name !== "MultiEdit" && name !== "Write") || outcome.structured === undefined) return false;
  const diff = record(result)?.diff;
  if (typeof diff !== "string" || diff === "") return false;
  return record(gatewayResult(name, input, { content: outcome.content, isError: outcome.isError }, cwd))?.diff !== diff;
}

/** Read's text with the line numbers Claude adds (`     1→text` or `1\ttext`) taken off. */
function withoutLineNumbers(said: string): string {
  return said
    .split("\n")
    .map((line) => line.replace(/^\s*\d+(?:\t|→)/, ""))
    .join("\n");
}

function todoText(todos: unknown): string {
  if (!Array.isArray(todos)) return "";
  return todos
    .map((todo) => {
      const entry = record(todo);
      const mark = entry?.status === "completed" ? "✓" : entry?.status === "in_progress" ? "→" : "○";
      return `${mark} ${text(entry?.content) ?? ""}`;
    })
    .join("\n");
}

/**
 * The answers to an AskUserQuestion call, as the app's history reads them: from the
 * structured result when there is one, else from the text Claude was given
 * (`"<question>"="<answer>"`).
 */
function answersOf(input: Record<string, unknown>, structured: Record<string, unknown> | undefined, said: string): { question: string; user_response: string }[] {
  const given = record(structured?.answers) ?? record(input.answers);
  return questionsOf(input).map((question) => {
    let answer = text(given?.[question.question]);
    if (answer === undefined) {
      const quoted = JSON.stringify(question.question);
      const at = said.indexOf(`${quoted}="`);
      if (at >= 0) answer = /^"((?:[^"\\]|\\.)*)"/.exec(said.slice(at + quoted.length + 1))?.[1];
    }
    return { question: question.question, user_response: answer ?? "" };
  });
}

// MARK: Diffs

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * A path as a diff names it: relative to the thread's folder when inside it, else whole,
 * with its leading "/" (`a//etc/hosts`), so a file outside is not read as one inside
 * (a turn's diff, feature turn_diff, opens it by that path).
 */
export function diffPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** A unified diff from Claude's structured patch. */
export function unifiedDiff(path: string, hunks: Hunk[], cwd: string): string {
  const name = diffPath(path, cwd);
  const lines = [`--- a/${name}`, `+++ b/${name}`];
  for (const hunk of hunks) {
    lines.push(`@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`);
    for (const line of hunk.lines) lines.push(line);
  }
  return lines.join("\n") + "\n";
}

function splitLines(value: string): string[] {
  if (value === "") return [];
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * A diff from an edit's old and new text, without line numbers: history does not keep
 * the file, so where in it the change was is not known.
 */
export function replacementDiff(path: string, oldText: string, newText: string, cwd: string): string {
  const name = diffPath(path, cwd);
  const lines = [`--- a/${name}`, `+++ b/${name}`];
  for (const line of splitLines(oldText)) lines.push(`-${line}`);
  for (const line of splitLines(newText)) lines.push(`+${line}`);
  return lines.join("\n") + "\n";
}

/** The diff of an Edit or MultiEdit from its input alone. */
export function editDiff(name: string, input: Record<string, unknown>, cwd: string): string {
  const path = text(input.file_path) ?? "";
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const parts = input.edits.map((edit) => {
      const entry = record(edit) ?? {};
      return replacementDiff(path, text(entry.old_string) ?? "", text(entry.new_string) ?? "", cwd).split("\n").slice(2).join("\n");
    });
    const name = diffPath(path, cwd);
    return [`--- a/${name}`, `+++ b/${name}`, ...parts.map((part) => part.replace(/\n$/, ""))].join("\n") + "\n";
  }
  return replacementDiff(path, text(input.old_string) ?? "", text(input.new_string) ?? "", cwd);
}

/** A written file as an all-added diff; `created` when it is known to be new. */
export function addedDiff(path: string, content: string, cwd: string, created: boolean): string {
  const name = diffPath(path, cwd);
  const added = splitLines(content);
  const header = created ? [`--- /dev/null`, `+++ b/${name}`, `@@ -0,0 +${range(1, added.length)} @@`] : [`--- a/${name}`, `+++ b/${name}`];
  return [...header, ...added.map((line) => `+${line}`)].join("\n") + "\n";
}

// MARK: Approvals

/** One line about what a tool wants to do, for an approval card, plus a diff for edits. */
export function approvalCommand(name: string, input: Record<string, unknown>, cwd: string): string {
  switch (name) {
    case "Bash":
      return text(input.command) ?? "Run a command";
    case "Edit":
    case "MultiEdit":
      return `Edit ${text(input.file_path) ?? "a file"}\n${editDiff(name, input, cwd)}`;
    case "Write":
      return `Edit ${text(input.file_path) ?? "a file"}\n${addedDiff(text(input.file_path) ?? "", text(input.content) ?? "", cwd, false)}`;
    case "Read":
      return `Read ${text(input.file_path) ?? "a file"}`;
    case "WebFetch":
      return `Fetch ${text(input.url) ?? "a page"}`;
    case "WebSearch":
      return `Search the web for ${text(input.query) ?? "something"}`;
    default: {
      const compact = JSON.stringify(input);
      return compact && compact !== "{}" ? `${name} ${compact.length > 300 ? cutWhole(compact, 300) + "…" : compact}` : name;
    }
  }
}
