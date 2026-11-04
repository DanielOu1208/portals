import type { AgentRequest, ApprovalChoice, ClarifyQuestion, RequestAnswer, ThreadMode } from "../types.ts";
import { changeApprovalText, displayCommand } from "./tools.ts";
import type { FileUpdateChange, RequestId } from "./types/index.ts";

// Codex's requests to the person (docs/bridge-spikes.md, S1) as the app's cards, and
// the card's answer back as Codex's response:
//
// - `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` are
//   approval cards. once is `accept`, session `acceptForSession`, always the exec-policy
//   amendment Codex offers (commands only, and only when offered), deny `decline` (the
//   turn goes on; `cancel` would stop it).
// - A command's approval to reach a host on the network (`networkApprovalContext`) names
//   the host, and always is the amendment that allows that host from then on, when offered.
// - `item/tool/requestUserInput` is a clarify card; the answers go back keyed by the
//   question ids.
// - Questions asked without waiting (`request_user_input_async`, which GPT-6.1 Sol has
//   in any mode) are no request: Codex goes on at once, and the person's next message
//   answers them. They come as an `agentMessage` with `delivery: "async"` and
//   `questions` (`asyncQuestions`), whose text is the questions with their options as
//   a list: a `questions` event, which the bridge puts to the person as a card.
// - Requests the app has no card for are declined with a notice, or refused.
// - The plan a turn in Codex's plan mode ends with is a plan card of the bridge's own,
//   which no request of Codex's stands behind (./session.ts).

type Params = Record<string, any>;

export const commandApproval = "item/commandExecution/requestApproval";
export const fileChangeApproval = "item/fileChange/requestApproval";
export const userInput = "item/tool/requestUserInput";

/** The host a command's approval asks to reach (`networkApprovalContext`), if it asks for one. */
function networkHost(params: Params): string | null {
  const host = params.networkApprovalContext?.host;
  return typeof host === "string" && host.trim() !== "" ? host.trim() : null;
}

/** What `available` holds for an exec-policy amendment ("always"), or for the network one that allows the host, if Codex offers one. */
function amendment(params: Params): unknown {
  const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : null;
  const host = networkHost(params);
  if (host) {
    const allows = offered
      ? offered.find((decision: Params) => decision?.applyNetworkPolicyAmendment?.network_policy_amendment?.action === "allow")
      : (Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments : [])
        .filter((proposed: Params) => proposed?.action === "allow")
        .map((proposed: Params) => ({ applyNetworkPolicyAmendment: { network_policy_amendment: proposed } }))[0];
    if (allows) return allows;
  }
  if (offered) return offered.find((decision: unknown) => decision && typeof decision === "object" && "acceptWithExecpolicyAmendment" in decision);
  return Array.isArray(params.proposedExecpolicyAmendment) && params.proposedExecpolicyAmendment.length > 0
    ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } }
    : undefined;
}

function offers(params: Params, decision: string): boolean {
  const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : null;
  return offered === null || offered.includes(decision);
}

/** The card for an approval request. `changes` are those of the file change it is about, when known. */
export function approvalRequest(method: string, params: Params, cwd: string, changes: readonly FileUpdateChange[] | undefined): AgentRequest {
  if (method === fileChangeApproval) {
    const list = changes ?? [];
    let description = typeof params.reason === "string" && params.reason.trim() !== "" ? params.reason : list.length > 1 ? "Codex wants to change files" : "Codex wants to change a file";
    if (typeof params.grantRoot === "string" && params.grantRoot !== "") description += ` (and to write anywhere in ${params.grantRoot} for the rest of the thread)`;
    return { kind: "approval", command: changeApprovalText(list, cwd), description, choices: ["once", "session", "deny"] };
  }
  const choices: ApprovalChoice[] = ["once"];
  if (offers(params, "acceptForSession")) choices.push("session");
  if (amendment(params)) choices.push("always");
  choices.push("deny");
  const host = networkHost(params);
  const command = typeof params.command === "string" && params.command !== "" ? displayCommand(params.command) : host ?? "Run a command";
  const fallback = host ? `Codex wants to reach ${host}` : params.kind === "writeStdin" ? "Codex wants to type into a command that is running" : "Codex wants to run a command";
  const reason = typeof params.reason === "string" ? params.reason.trim() : "";
  // Codex's reason, with the host when it does not name it.
  const description = reason === "" ? fallback : host && !reason.includes(host) ? `${reason} (${host})` : params.reason;
  return { kind: "approval", command, description, choices };
}

/** The response to an approval request for the card's answer. */
export function approvalResponse(method: string, params: Params, choice: ApprovalChoice): { decision: unknown } {
  switch (choice) {
    case "once":
      return { decision: "accept" };
    case "session":
      return { decision: "acceptForSession" };
    case "always":
      return { decision: method === commandApproval ? (amendment(params) ?? "accept") : "accept" };
    case "deny":
      return { decision: "decline" };
  }
}

/**
 * The card for a plan Codex proposed in plan mode: approving it carries it out in
 * `startsIn`; what is said with a no is the session's to send, in plan mode.
 */
export function planRequest(plan: string, startsIn: ThreadMode): AgentRequest {
  return { kind: "approval", command: plan.trim(), description: "Codex has a plan", choices: ["once", "deny"], plan: { startsIn }, takesNote: true };
}

/** What Codex is told when its plan is approved, the words of Codex's own app. */
export const implementPlanText = "Implement the plan.";

/** The card for `item/tool/requestUserInput`. */
export function clarifyRequest(params: Params): AgentRequest {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return {
    kind: "clarify",
    questions: questions
      .filter((question: Params) => typeof question?.id === "string" && typeof question.question === "string")
      .map((question: Params) => {
        const options: Params[] = Array.isArray(question.options) ? question.options.filter((option: Params) => typeof option?.label === "string") : [];
        const descriptions: Record<string, string> = {};
        for (const option of options) {
          if (typeof option.description === "string" && option.description.trim() !== "") descriptions[option.label] = option.description.trim();
        }
        const header = typeof question.header === "string" ? question.header.trim() : "";
        return {
          qid: question.id,
          question: question.question,
          choices: options.map((option) => option.label as string),
          multiSelect: false,
          ...(header ? { header } : {}),
          ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
        };
      }),
  };
}

/** The thread's row for a `item/tool/requestUserInput` card: a `clarify` tool's, which the app shows as asked and answered. */
export function clarifyRow(params: Params, request: Extract<AgentRequest, { kind: "clarify" }>): { id: string; name: "clarify"; args: Record<string, unknown> } {
  const id = typeof params.itemId === "string" && params.itemId !== "" ? params.itemId : `ask-${requestKey(userInput, params)}`;
  return { id, name: "clarify", args: { questions: request.questions.map((question) => ({ question: question.question, choices: question.choices })) } };
}

/** Its result: each question's answer ("" skipped), or `unanswered` when the card was taken back. */
export function clarifyResult(params: Params, answer: RequestAnswer): unknown {
  if (answer.kind === "withdrawn") return { responses: [], unanswered: true };
  const questions: Params[] = Array.isArray(params.questions) ? params.questions : [];
  const answers = answer.kind === "clarify" ? answer.answers : null;
  return {
    responses: questions
      .filter((question) => typeof question?.id === "string" && typeof question.question === "string")
      .map((question) => ({ question: question.question, user_response: answers?.[question.id]?.trim() ?? "" })),
  };
}

/**
 * The questions of an `agentMessage` that asks them without waiting (`delivery: "async"`):
 * each with its options, when it has any; none for any other message.
 */
export function asyncQuestions(item: Params): ClarifyQuestion[] {
  if (item.delivery !== "async" || !Array.isArray(item.questions)) return [];
  return item.questions
    .filter((question: Params) => typeof question?.title === "string" && question.title.trim() !== "")
    .map((question: Params, index: number) => ({
      qid: `q${index}`,
      question: question.title.trim(),
      choices: Array.isArray(question.options) ? question.options.filter((option: unknown): option is string => typeof option === "string" && option.trim() !== "") : [],
      multiSelect: false,
    }));
}

/** The response to `item/tool/requestUserInput`: each answered question's answer; none when the card was dismissed. */
export function clarifyResponse(params: Params, answers: Record<string, string | null> | null): { answers: Record<string, { answers: string[] }> } {
  const out: Record<string, { answers: string[] }> = {};
  if (!answers) return { answers: out };
  for (const question of Array.isArray(params.questions) ? params.questions : []) {
    const given = answers[question?.id];
    if (typeof given === "string" && given.trim() !== "") out[question.id] = { answers: [given] };
  }
  return { answers: out };
}

/**
 * The response for a request nobody answered from the phone: the turn was interrupted
 * (`cancel` stops what is waiting), or it ended. Null when Codex needs no answer: the
 * thread's own request goes with its turn. A sub-agent's (`subAgent`) does not: it works
 * on after the turn of the thread it works for, and waits for an answer, so one taken back
 * as that turn ended (by an app that cannot keep its card past the turn) is a no.
 */
export function withdrawnResponse(method: string, reason: string, subAgent = false): unknown {
  if (reason === "withdrawn" && subAgent) return method === userInput ? { answers: {} } : { decision: "decline" };
  if (reason !== "interrupted") return null;
  if (method === userInput) return { answers: {} };
  return { decision: "cancel" };
}

/** The response from an answer, for a request the bridge put to the phone (a sub-agent's when `subAgent`). Null when nothing is to be sent. */
export function responseFor(method: string, params: Params, answer: RequestAnswer, subAgent = false): unknown {
  if (answer.kind === "withdrawn") return withdrawnResponse(method, answer.reason, subAgent);
  if (method === userInput) return clarifyResponse(params, answer.kind === "clarify" ? answer.answers : null);
  return approvalResponse(method, params, answer.kind === "approval" ? answer.choice : "deny");
}

/**
 * The same request as Codex sends it again after a reconnect (it may come with another
 * id): its method, item and approval id.
 */
export function requestKey(method: string, params: Params): string {
  return `${method}|${params.itemId ?? ""}|${params.approvalId ?? ""}`;
}

/** Request ids as Codex sends them, compared whether a number or a string. */
export function idKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}
