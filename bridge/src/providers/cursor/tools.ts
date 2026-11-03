import { machineWord } from "../../platform.ts";
import type { GatewayTool, OwnTools, ToolCall } from "../acp/tools.ts";

// What is Cursor's own in its tool calls, beside what the library reads from a call's
// kind (../acp/tools.ts). Cursor gives every call a kind, a title and what the tool was
// given (`rawInput`); several of its tools share the kind `other` or `search` and are
// told apart only there, some by a name Cursor adds for clients (`_toolName`).
//
// A call that did not work is still `completed`. A command says so by its exit code,
// which the library reads; any other tool by `{error}`, `{rejected: true, reason}` or
// `{permissionDenied: true}` in what it returned (`rawOutput`).

/** The tool calls a card or a row of the provider's own stands for: the plan card, the to-do row. */
const notShown = new Set(["updateTodos", "createPlan"]);

/**
 * What closes a command's row that a stop, or the end of Cursor's process, left open
 * while the command ran. One Cursor was still asking about closes plainly (the library
 * sees to that): Cursor runs a command only once it has a yes.
 */
export const commandLeftText = `Stopped. The command may still be running on the ${machineWord()}: Cursor does not say whether it ended.`;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Only the keys that are set. */
function set(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

/** The name Cursor adds to what some of its tools were given. */
function toolName(call: ToolCall): string | undefined {
  return text(record(call.rawInput)?._toolName);
}

/** The questions of an ask-question call, as the app's history reads a question row. */
function questionsOf(input: Record<string, unknown>): { question: string; choices: string[] }[] {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions.flatMap((entry) => {
    const question = record(entry);
    const prompt = text(question?.prompt);
    if (!prompt) return [];
    const options = Array.isArray(question?.options) ? question.options : [];
    return [{ question: prompt, choices: options.flatMap((option) => text(record(option)?.label) ?? []) }];
  });
}

function cursorTool(call: ToolCall): GatewayTool | undefined {
  const input = record(call.rawInput) ?? {};
  const title = text(call.title?.trim());
  const labelled = title ? { context: title } : {};
  switch (toolName(call)) {
    case "task":
      // The label is the short description; the prompt is the input shown.
      return { name: "delegate_task", args: set({ task: text(input.prompt), agent: text(input.subagentType) }), ...(text(input.description) ? { context: input.description as string } : labelled) };
    case "generateImage":
      return { name: "image_generate", args: set({ prompt: text(input.description) }), ...(text(input.description) ? {} : labelled) };
    case "askQuestion":
      // The app shows the question as a card of its own and skips this row.
      return { name: "clarify", args: { questions: questionsOf(input) } };
    default:
      break;
  }
  // The model changed the session's mode by itself, of which Cursor tells nothing else.
  if (call.kind === "switch_mode") return { name: "switch_mode", args: set({ mode: text(input.targetModeId), explanation: text(input.explanation) }), ...labelled };
  // A web search has the kind of a search in files, and is known by what it was given.
  if (call.kind === "search" && (text(input.searchTerm) || /^web search\b/i.test(title ?? ""))) {
    return text(input.searchTerm) ? { name: "web_search", args: { query: input.searchTerm } } : { name: "web_search", args: {}, ...labelled };
  }
  // A tool of an MCP server goes by its own name.
  if (call.kind === "other" && text(input.toolName)) return { name: input.toolName as string, args: record(input.args) ?? {}, ...labelled };
  return undefined;
}

/** What a search found, where Cursor gives only a count. */
function found(output: Record<string, unknown>): string | undefined {
  const counts: [unknown, string][] = [
    [output.totalMatches, "match"],
    [output.totalFiles, "file"],
    [output.resultCount, "result"],
    [output.referenceCount, "reference"],
  ];
  for (const [count, what] of counts) {
    if (typeof count !== "number") continue;
    const plural = count === 1 ? what : what === "match" ? "matches" : `${what}s`;
    return `${count} ${plural}${output.truncated === true ? " (cut short)" : ""}`;
  }
  return undefined;
}

/**
 * Cursor's tools for one thread. `answers` holds what the user answered each question
 * with, by the question's tool call, which that call's row then ends with.
 */
export function cursorTools(answers: ReadonlyMap<string, string[]>): OwnTools {
  return {
    hidden: (call) => notShown.has(toolName(call) ?? ""),
    tool: cursorTool,
    result(call, tool) {
      // As the app's history reads a question's answers; none is a question skipped.
      if (tool.name === "clarify") return { responses: (answers.get(call.toolCallId) ?? []).map((answer) => ({ user_response: answer })) };
      const output = record(call.rawOutput);
      if (!output) return undefined;
      if (output.rejected === true || output.permissionDenied === true) {
        const reason = text(output.reason);
        const byUser = reason === "User rejected";
        return {
          status: "blocked",
          error: reason ?? "Cursor did not allow this.",
          user_summary: byUser ? "You denied this — it did not run." : "Cursor did not allow this — it did not run.",
        };
      }
      // A command's own output may be called `error`; its exit code says how it went.
      const error = tool.name === "terminal" ? undefined : text(output.error);
      if (error) return tool.name === "patch" || tool.name === "write_file" ? { success: false, error } : { error };
      if (tool.name === "search_files" || tool.name === "web_search") {
        const summary = found(output);
        if (summary) return { output: summary };
      }
      return undefined;
    },
    stopped: (tool) => (tool.name === "terminal" ? commandLeftText : undefined),
  };
}
