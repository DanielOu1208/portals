import type { PermissionMode, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRequest, ApprovalChoice, RequestAnswer } from "../types.ts";
import { approvalCommand, denialMessage, questionsOf } from "./tools.ts";

// Claude's permission prompts (`canUseTool`) as the app's cards, and the card's answer
// back as Claude's permission result:
//
// - AskUserQuestion (asked even when nothing else is) is a clarify card; the answers go
//   back in `updatedInput.answers`, keyed by question text.
// - ExitPlanMode (plan mode) is an approval card whose text is the plan.
// - Any other tool is an approval card: once allows it, session allows it with Claude's
//   suggested rules kept for this session, always with them as Claude suggested (saved
//   in the folder's local settings), deny says no, and what the user said with it goes
//   to Claude as the reason.

/** The card for a tool Claude wants to use. */
export function permissionRequest(toolName: string, input: Record<string, unknown>, suggestions: PermissionUpdate[] | undefined, cwd: string): AgentRequest {
  if (toolName === "AskUserQuestion") {
    return {
      kind: "clarify",
      questions: questionsOf(input).map((question, index) => ({
        qid: `q${index}`,
        question: question.question,
        choices: question.labels,
        multiSelect: question.multiSelect,
        ...(question.header ? { header: question.header } : {}),
        ...(Object.keys(question.descriptions).length > 0 ? { descriptions: question.descriptions } : {}),
      })),
    };
  }
  if (toolName === "ExitPlanMode") {
    const plan = typeof input.plan === "string" && input.plan.trim() !== "" ? input.plan : "Claude has finished planning.";
    return { kind: "approval", command: plan, description: "Claude has a plan", choices: ["once", "deny"], takesNote: true };
  }
  const choices: ApprovalChoice[] = ["once"];
  if (suggestions && suggestions.length > 0) {
    choices.push("session");
    // "Always" only when a suggestion would outlast the session.
    if (suggestions.some((suggestion) => suggestion.destination !== "session")) choices.push("always");
  }
  choices.push("deny");
  return { kind: "approval", command: approvalCommand(toolName, input, cwd), description: describe(toolName), choices, takesNote: true };
}

function describe(toolName: string): string {
  switch (toolName) {
    case "Bash":
      return "Claude wants to run a command";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "Claude wants to change a file";
    default:
      return `Claude wants to use ${toolName}`;
  }
}

/** The card's answer as what Claude is told. */
export function permissionResult(
  toolName: string,
  input: Record<string, unknown>,
  suggestions: PermissionUpdate[] | undefined,
  answer: RequestAnswer,
  /** For an approved plan: the mode its work starts in. Without one Claude goes back to asking. */
  planMode: PermissionMode | null = null,
): PermissionResult {
  if (answer.kind === "withdrawn") {
    return { behavior: "deny", message: "The question was withdrawn before anyone answered it." };
  }
  if (toolName === "AskUserQuestion") {
    if (answer.kind !== "clarify" || answer.answers === null) {
      return { behavior: "deny", message: "The user dismissed the question without answering it." };
    }
    const answers: Record<string, string> = {};
    questionsOf(input).forEach((question, index) => {
      const given = answer.answers?.[`q${index}`];
      if (typeof given === "string" && given.trim() !== "") answers[question.question] = given;
    });
    if (Object.keys(answers).length === 0) {
      return { behavior: "deny", message: "The user skipped the question." };
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  const choice = answer.kind === "approval" ? answer.choice : "deny";
  const note = answer.kind === "approval" ? answer.note : undefined;
  if (toolName === "ExitPlanMode") {
    if (choice === "deny") {
      return {
        behavior: "deny",
        message: note
          ? `The plan was not approved in Portals. Keep planning, and change this: ${note}`
          : "The plan was not approved in Portals. Keep planning, or ask what to change.",
      };
    }
    return planMode
      ? { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode: planMode, destination: "session" }] }
      : { behavior: "allow", updatedInput: input };
  }
  switch (choice) {
    case "once":
      return { behavior: "allow", updatedInput: input };
    case "session":
      return { behavior: "allow", updatedInput: input, updatedPermissions: (suggestions ?? []).map((suggestion) => ({ ...suggestion, destination: "session" })) };
    case "always":
      return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions ?? [] };
    case "deny":
      return { behavior: "deny", message: note ? `${denialMessage} The user wants this instead: ${note}` : denialMessage };
  }
}
