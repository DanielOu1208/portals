import type { PermissionOption, PermissionOutcome, ToolCallFields } from "../acp/protocol.ts";
import { approvalCommand, contentText, planTool, type GatewayTool, type ToolCall, type ToolQuirks } from "../acp/tools.ts";
import type { AgentRequest, ApprovalChoice, RequestAnswer } from "../types.ts";
import { cursorName } from "./options.ts";

// Cursor's requests to the client as the app's cards and rows, and a card's answer back
// as Cursor's response:
//
// - `session/request_permission` is an approval card: once is `allow-once`, always
//   `allow-always` (Cursor then adds the command, path or domain to its own allowlist),
//   deny `reject-once`.
// - `cursor/ask_question` is a clarify card. Cursor takes the ids of the options
//   chosen and nothing else, so an answer in the user's own words goes back as the
//   question skipped, with the words as the reason, which Cursor hands to the model.
// - `cursor/create_plan` is a plan card: Start accepts the plan, Keep planning sends it
//   back with what the user wrote.
// - `cursor/update_todos` is a to-do row; `cursor/task` and `cursor/generate_image`
//   tell of something their tool calls already showed.
//
// The `cursor/` requests name no session, only the tool call they belong to: which
// thread one is for is the provider's business (./provider.ts). One that cannot be shown
// to anybody is still answered, and never with an error: Cursor takes an error for
// consent to a plan, and asks a question again as permission cards.

type Params = Record<string, any>;

export const permissionRequest = "session/request_permission";
export const askQuestion = "cursor/ask_question";
export const createPlan = "cursor/create_plan";
export const updateTodos = "cursor/update_todos";
const told = ["cursor/task", "cursor/generate_image"];

/** One of Cursor's own requests that the bridge knows. Any other is refused. */
export function isCursorRequest(method: string): boolean {
  return method === askQuestion || method === createPlan || method === updateTodos || told.includes(method);
}

const cancelled = { outcome: { outcome: "cancelled" } } as const;

/** The answer to a request of Cursor's own that no thread can be shown. */
export function unplacedAnswer(method: string): unknown {
  if (method === createPlan) return { outcome: { outcome: "rejected", reason: "Portals could not show this plan." } };
  if (method === askQuestion) return cancelled;
  return {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// MARK: Permissions

function optionOfKind(options: PermissionOption[], ...kinds: string[]): PermissionOption | undefined {
  for (const kind of kinds) {
    const found = options.find((option) => option?.kind === kind && typeof option.optionId === "string");
    if (found) return found;
  }
  return undefined;
}

/** The options of a permission request as the card's choices: Cursor's are allow once, allow always and reject. */
function offered(options: PermissionOption[]): { once?: PermissionOption; always?: PermissionOption; no?: PermissionOption } {
  const always = optionOfKind(options, "allow_always");
  const no = optionOfKind(options, "reject_once", "reject_always");
  // Kinds of a later Cursor's own: the first option that is not a no is the yes.
  const once = optionOfKind(options, "allow_once") ?? (always ? undefined : options.find((option) => option !== no && typeof option?.optionId === "string"));
  return { once, always, no };
}

function wants(tool: GatewayTool, call: ToolCall): string {
  switch (tool.name) {
    case "terminal":
      return `${cursorName} wants to run a command`;
    case "patch":
    case "write_file":
      return `${cursorName} wants to change a file`;
    case "read_file":
      return `${cursorName} wants to read a file`;
    case "delete_file":
      return `${cursorName} wants to delete a file`;
    case "web_search":
      return `${cursorName} wants to search the web`;
    case "web_extract":
      return `${cursorName} wants to fetch a page`;
    default:
      if (call.kind === "search") return `${cursorName} wants to search`;
      return `${cursorName} wants to use a tool`;
  }
}

/**
 * The card for a permission request. `asked` is the request's own account of the call;
 * `call` and `tool` are the call as far as it is known, and its row. `announced`: the
 * request is about a tool call Cursor told of before, whose row shows what it is; one
 * under an id of its own (a web search, a fetch) has only Cursor's title to go by.
 */
export function permissionCard(asked: ToolCallFields, options: PermissionOption[], call: ToolCall, tool: GatewayTool, announced: boolean, cwd: string, quirks: ToolQuirks): AgentRequest {
  const { once, always } = offered(options);
  const choices: ApprovalChoice[] = [...(once ? (["once"] as const) : []), ...(always ? (["always"] as const) : []), "deny"];
  const title = text(asked.title)?.trim();
  const command = !announced && title ? title : approvalCommand(call, tool, cwd, quirks);
  // Cursor gives its reason for a command or a read as the request's text. An MCP tool's is what the tool is given, not a reason.
  const reason = asked.kind === "execute" || asked.kind === "read" ? text(contentText(asked.content)) : undefined;
  return { kind: "approval", command, description: reason ?? wants(tool, call), choices };
}

/** The card's answer as Cursor's: one of its options, or `cancelled` when nobody answered. */
export function permissionOutcome(options: PermissionOption[], answer: RequestAnswer): PermissionOutcome {
  if (answer.kind !== "approval") return cancelled;
  const { once, always, no } = offered(options);
  const chosen = answer.choice === "deny" ? no : answer.choice === "always" ? (always ?? once) : (once ?? always);
  // A no that Cursor offers no option for stops the call the only other way there is.
  return chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : cancelled;
}

// MARK: Questions

interface Option {
  id: string;
  label: string;
}

interface Question {
  id: string;
  prompt: string;
  options: Option[];
  multiple: boolean;
}

function questionsOf(params: Params): Question[] {
  const questions: Params[] = Array.isArray(params?.questions) ? params.questions : [];
  return questions
    .filter((question) => typeof question?.id === "string" && typeof question.prompt === "string")
    .map((question) => ({
      id: question.id,
      prompt: question.prompt,
      options: (Array.isArray(question.options) ? question.options : []).filter((option: Params) => typeof option?.id === "string" && typeof option.label === "string"),
      multiple: question.allowMultiple === true,
    }));
}

/** The card for `cursor/ask_question`; null when it asks nothing. */
export function questionCard(params: Params): AgentRequest | null {
  const questions = questionsOf(params);
  if (questions.length === 0) return null;
  const header = text(params?.title)?.trim();
  return {
    kind: "clarify",
    questions: questions.map((question, index) => ({
      qid: `q${index}`,
      question: question.prompt,
      choices: question.options.map((option) => option.label),
      multiSelect: question.multiple,
      ...(header ? { header } : {}),
    })),
  };
}

/**
 * The options an answer names. The app answers in words: a pick is its label, and
 * several picks are joined by ", ". So the answer is read as whole labels, the longest
 * first, which finds a label with a comma in it too. Null when it holds anything else.
 */
export function chosenOptions(answer: string, options: Option[]): string[] | null {
  const byLength = [...options].filter((option) => option.label !== "").sort((a, b) => b.label.length - a.label.length);
  const read = (rest: string): string[] | null => {
    for (const option of byLength) {
      if (!rest.startsWith(option.label)) continue;
      const after = rest.slice(option.label.length);
      if (after === "") return [option.id];
      if (!after.startsWith(", ")) continue;
      const more = read(after.slice(2));
      if (more) return [option.id, ...more];
    }
    return null;
  };
  return read(answer.trim());
}

/**
 * The card's answer as Cursor's, and what the user said to each question in words (the
 * question's row ends with those). `answered` with the options chosen; `skipped` when
 * the card was dismissed, nothing was answered, or an answer was in the user's own
 * words, which then go back as the reason; `cancelled` when the turn was stopped.
 */
export function questionOutcome(params: Params, answer: RequestAnswer): { response: unknown; said: string[] } {
  if (answer.kind === "withdrawn") return { response: cancelled, said: [] };
  const skipped = (reason: string, said: string[] = []) => ({ response: { outcome: { outcome: "skipped", reason } }, said });
  if (answer.kind !== "clarify" || answer.answers === null) return skipped("The user dismissed the question without answering it.");
  const questions = questionsOf(params);
  const given = questions.map((question, index) => ({ question, words: (answer.answers?.[`q${index}`] ?? "").trim() })).filter((entry) => entry.words !== "");
  if (given.length === 0) return skipped("The user skipped the question.");
  const said = given.map((entry) => entry.words);
  const answers: { questionId: string; selectedOptionIds: string[] }[] = [];
  for (const { question, words } of given) {
    const chosen = chosenOptions(words, question.options);
    // One pick only where the question allows one: more is the user's own words.
    if (!chosen || (chosen.length > 1 && !question.multiple)) {
      const inWords = given.map((entry) => `${entry.question.prompt} ${entry.words}`).join("\n");
      return skipped(`The user answered in their own words, not with one of the options. Take this as the answer:\n${inWords}`, said);
    }
    answers.push({ questionId: question.id, selectedOptionIds: chosen });
  }
  return { response: { outcome: { outcome: "answered", answers } }, said };
}

// MARK: Plans

/** The card for `cursor/create_plan`: the plan under its name and overview. Start begins the work in the agent's own mode. */
export function planCard(params: Params): AgentRequest {
  const parts = [text(params?.name), text(params?.overview), text(params?.plan)].flatMap((part) => (part ? [part.trim()] : []));
  return {
    kind: "approval",
    command: parts.length > 0 ? parts.join("\n\n") : `${cursorName} has finished planning.`,
    description: `${cursorName} has a plan`,
    choices: ["once", "deny"],
    plan: { startsIn: "default" },
    // Cursor reads a note given with a no as the reason (`planOutcome`): it is not sent again as a message.
    takesNote: true,
  };
}

/**
 * The card's answer as Cursor's. Accepted without a `planUri`, so Cursor keeps the plan
 * where it keeps its plans; rejected with what the user wrote, which the model reads
 * before it plans again; `cancelled` when the turn was stopped.
 */
export function planOutcome(answer: RequestAnswer): { response: unknown; accepted: boolean } {
  if (answer.kind !== "approval") return { response: cancelled, accepted: false };
  if (answer.choice !== "deny") return { response: { outcome: { outcome: "accepted" } }, accepted: true };
  const reason = answer.note ? answer.note : "The plan was not approved in Portals. Keep planning, or ask what to change.";
  return { response: { outcome: { outcome: "rejected", reason } }, accepted: false };
}

// MARK: To-dos

export interface Todo {
  id: string;
  content: string;
  status: string;
}

/**
 * The thread's to-do list after `cursor/update_todos`. The first of a list has `merge`
 * false and every item; later ones have `merge` true and only the items that changed.
 */
export function mergedTodos(known: readonly Todo[], params: Params): Todo[] {
  const sent: Todo[] = (Array.isArray(params?.todos) ? params.todos : [])
    .filter((todo: Params) => typeof todo?.id === "string")
    .map((todo: Params) => ({ id: todo.id, content: typeof todo.content === "string" ? todo.content : "", status: typeof todo.status === "string" ? todo.status : "pending" }));
  if (params?.merge !== true) return sent;
  const todos = known.map((todo) => sent.find((changed) => changed.id === todo.id) ?? todo);
  return [...todos, ...sent.filter((changed) => !known.some((todo) => todo.id === changed.id))];
}

/** A to-do list as read from a thread's file: one written by hand or cut short holds anything. */
export function keptTodos(value: unknown): Todo[] {
  if (!Array.isArray(value)) return [];
  return value.filter((todo): todo is Todo => typeof todo?.id === "string" && typeof todo.content === "string" && typeof todo.status === "string");
}

/** The whole list as a to-do row, in the shape the library's plan row has. */
export function todoRow(todos: readonly Todo[]): { tool: GatewayTool; result: unknown } {
  return planTool(todos.map((todo) => ({ content: todo.content, status: todo.status })));
}
