import {
  RequestPermissionResultSchema, ToolConfirmationOutcome, type AskUserRequestParams, type AskUserResult, type PickOptionsRequestParams,
  type PickOptionsResult, type RequestPermissionHandlerResult, type RequestPermissionRequestParams,
} from "@factory/droid-sdk/node";
import { chosenOptions } from "../cursor/requests.ts";
import type { AgentRequest, SessionSink, ThreadMode } from "../types.ts";
import { approvalDetails, approvalOptions } from "./approvals.ts";

export async function requestPermission(
  params: RequestPermissionRequestParams, sink: SessionSink, signal: AbortSignal,
  startsIn: ThreadMode, approved: (outcome: ToolConfirmationOutcome) => void, cwd = "/", subagent?: string,
): Promise<RequestPermissionHandlerResult> {
  const offered = new Set(params.options.map((option) => option.value));
  if (!offered.has(ToolConfirmationOutcome.Cancel)) throw new Error("Droid offered no safe cancellation for this request.");
  if (signal.aborted) return ToolConfirmationOutcome.Cancel;
  if (params.toolUses.some((tool) => tool.confirmationType === "propose_mission" || tool.confirmationType === "start_mission_run" || tool.confirmationType === "recommend_mission")) {
    sink.emit({ type: "notice", level: "warn", text: "Droid Missions are not supported in Portals yet." });
    return ToolConfirmationOutcome.Cancel;
  }
  const plan = params.toolUses.find((tool) => tool.details.type === "exit_spec_mode")?.details;
  const details = approvalDetails(params, cwd);
  const options = approvalOptions(params);
  const request: AgentRequest = {
    kind: "approval", command: plan?.type === "exit_spec_mode"
      ? `${plan.title ? `# ${plan.title}\n\n` : ""}${plan.plan}`
      : details.map((d) => [d.command ?? d.path ?? d.tool ?? d.name, d.diff].filter(Boolean).join("\n\n")).join("\n\n"),
    description: plan ? "Droid's plan, awaiting approval"
      : params.toolUses.some((tool) => tool.details.type === "script") ? "Droid wants permission for what this Script does" : "Droid wants permission for this action",
    choices: [...(offered.has(ToolConfirmationOutcome.ProceedOnce) ? ["once" as const] : []), "deny"],
    takesNote: true, options, details, ...(subagent ? { subagent } : {}),
    ...(plan?.type === "exit_spec_mode" ? { plan: { startsIn }, planContent: plan.plan } : {}),
  };
  const answer = await sink.ask(request, signal);
  if (!signal.aborted && answer.kind === "approval.option") {
    const option = options.find((option) => option.id === answer.option);
    if (option && (option.id !== ToolConfirmationOutcome.ProceedEdit || answer.editedPlan?.trim())) {
      const result = RequestPermissionResultSchema.safeParse({ selectedOption: option.id,
        ...(answer.editedPlan === undefined ? {} : { editedSpecContent: answer.editedPlan }),
        ...(answer.note ? { comment: answer.note } : {}) });
      if (result.success) {
        if (result.data.selectedOption !== ToolConfirmationOutcome.Cancel && result.data.selectedOption !== ToolConfirmationOutcome.ProceedEdit) approved(result.data.selectedOption);
        const { selectedOption, comment, editedSpecContent } = result.data;
        if (selectedOption === ToolConfirmationOutcome.ProceedEdit) {
          if (typeof editedSpecContent === "string") return { selectedOption, editedSpecContent, ...(comment ? { comment } : {}) };
        } else return { selectedOption, ...(comment ? { comment } : {}) };
      }
    }
  }
  if (!signal.aborted && answer.kind === "approval" && answer.choice === "once" && offered.has(ToolConfirmationOutcome.ProceedOnce)) {
    if (plan) approved(ToolConfirmationOutcome.ProceedOnce);
    return ToolConfirmationOutcome.ProceedOnce;
  }
  return { selectedOption: ToolConfirmationOutcome.Cancel,
    ...((answer.kind === "approval" || answer.kind === "approval.option") && answer.note ? { comment: answer.note } : {}) };
}

export async function askUser(params: AskUserRequestParams, sink: SessionSink, signal: AbortSignal): Promise<AskUserResult> {
  if (signal.aborted || params.questions.length === 0) return { cancelled: true, answers: [] };
  const answer = await sink.ask({
    kind: "clarify", requiresAllAnswers: true,
    questions: params.questions.map((question) => ({
      qid: String(question.index), question: question.question, header: question.topic,
      choices: question.options, multiSelect: question.multiSelect === true,
    })),
  }, signal);
  if (signal.aborted || answer.kind !== "clarify" || !answer.answers) return { cancelled: true, answers: [] };
  const answers = params.questions.map((question) => ({
    index: question.index, question: question.question, answer: answer.answers![String(question.index)]?.trim() || "No answer provided.",
  }));
  return { answers };
}

type PickParams = PickOptionsRequestParams;
type PickResult = PickOptionsResult;
const notPicked: PickResult = { cancelled: true, selectedIds: [] };

/**
 * Droid's pick list (`droid.pick_options`, one of its integrations asking which rows to
 * use: a title, a hint, rows of an id, a label and a detail, one or several) as the
 * question card: its rows are the choices, shown with their detail, and the answer goes back
 * as the rows' ids. The card cannot preselect, so Droid's `preselectedIds` are not shown;
 * an answer in the person's own words, or none, cancels it, as Droid's own picker does.
 */
export async function pickOptions(params: PickParams, sink: SessionSink, signal: AbortSignal): Promise<PickResult> {
  if (signal.aborted || params.rows.length === 0) return notPicked;
  const shown = params.rows.map((row) => row.detail ? `${row.label} (${row.detail})` : row.label);
  // The card answers in words, several picks joined by ", ": choices that could be read two
  // ways (one holding ", ", or two alike) are numbered, so the answer names the rows picked.
  const ambiguous = new Set(shown).size < shown.length || shown.some((label) => label.includes(", "));
  const rows = params.rows.map((row, index) => ({ id: row.id, label: ambiguous ? `${index + 1}. ${shown[index]}` : shown[index] }));
  const answer = await sink.ask({
    kind: "clarify", requiresAllAnswers: true,
    questions: [{ qid: "pick", question: params.hint ? `${params.title}\n\n${params.hint}` : params.title,
      choices: rows.map((row) => row.label), multiSelect: params.multi }],
  }, signal);
  if (signal.aborted || answer.kind !== "clarify") return notPicked;
  const said = answer.answers?.pick;
  const chosen = typeof said === "string" ? chosenOptions(said, rows) : null;
  return chosen && chosen.length > 0 && (params.multi || chosen.length === 1) ? { selectedIds: chosen } : notPicked;
}
