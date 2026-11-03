import type { ClarifyQuestion, RequestAnswer, StoredMessage } from "../providers/types.ts";

// Questions an agent asked without waiting (feature async_questions): it takes the
// person's next message as their answer, so the answers given on the card go to it as
// one (sessions/session.ts, `askAhead`), and the thread's row of them says how they ended.
//
// That message is the card's answer, which their row shows: it is marked so
// (`card_answer`, the row's id), and the app shows no message of its own for it. An
// agent's history keeps the message but not that the card gave it (Codex's), so the
// thread's record keeps how each card was settled (`CardAnswer`), and a conversation
// read back from the agent takes it again (`withCardAnswers`). The last questions the
// conversation ends with, unanswered and unsettled (`openAsk`), are put again as their
// card once a device that keeps such cards opens the thread (a restart of the bridge
// since, which their card did not outlive).

/**
 * How questions asked without waiting were settled on their card, as the thread's record
 * keeps it (`ThreadRecord.cardAnswers`). `id` is their row's (their `clarify` tool's);
 * `answers` each question's answer in order ("" skipped), none when the card was taken
 * back unanswered (Stop); `said`, the message they went to the agent as, none when every
 * one was skipped.
 */
export interface CardAnswer {
  id: string;
  answers?: string[];
  said?: string;
}

/** How many a thread's record keeps: the latest. */
export const cardAnswersKept = 20;

/** A thread record's `cardAnswers`, but entries it cannot read. */
export function readCardAnswers(kept: unknown): CardAnswer[] {
  if (!Array.isArray(kept)) return [];
  return kept.filter((entry): entry is CardAnswer =>
    typeof entry?.id === "string" &&
    (entry.answers === undefined || (Array.isArray(entry.answers) && entry.answers.every((answer: unknown) => typeof answer === "string"))) &&
    (entry.said === undefined || typeof entry.said === "string"));
}

/** Their row's result for the answers given on their card, one per question in order. */
function cardResult(args: Record<string, unknown> | undefined, answers: readonly string[]): unknown {
  const questions: unknown[] = Array.isArray(args?.questions) ? args.questions : [];
  return {
    responses: questions.map((question, index) => ({
      question: typeof (question as { question?: unknown })?.question === "string" ? (question as { question: string }).question : "",
      user_response: answers[index] ?? "",
    })),
  };
}

/**
 * The stored conversation with how its questions asked without waiting were settled on
 * their card, as the thread's record keeps it: their row takes the answers given (or
 * that they were skipped), and the person's message right after it, when it is the one
 * the answers went to the agent as, is marked as the card's (`card_answer`). Rows of
 * questions taken back, and any message the person typed, are as the history has them.
 */
export function withCardAnswers(messages: StoredMessage[], kept: readonly CardAnswer[]): StoredMessage[] {
  if (kept.length === 0) return messages;
  const settled = new Map(kept.map((entry) => [entry.id, entry]));
  let given: StoredMessage[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const row = messages[index];
    if (row.role !== "tool" || row.name !== "clarify") continue;
    const entry = settled.get(row.tool_call_id);
    if (!entry?.answers) continue;
    given ??= messages.slice();
    given[index] = { ...row, content: JSON.stringify(cardResult(row.args, entry.answers)) };
    if (entry.said === undefined) continue;
    const next = messages.findIndex((message, at) => at > index && message.role === "user");
    const said = next === -1 ? undefined : messages[next];
    if (said?.role === "user" && said.text === entry.said && (said.display_kind === undefined || said.display_kind === "steer")) {
      given[next] = { ...said, card_answer: row.tool_call_id };
    }
  }
  return given ?? messages;
}

/**
 * The questions asked without waiting that the stored conversation ends with: the last
 * ones asked, unanswered, with no message of the person's after them, which their card
 * did not settle (skipped, or taken back with Stop: `kept`). Null when there are none: an
 * older one, one a message came after or one settled stays its row.
 */
export function openAsk(messages: readonly StoredMessage[], kept: readonly CardAnswer[]): { id: string; questions: ClarifyQuestion[] } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // Sent since, a message of the person's answered them (a line of the agent's own is none).
    if (message.role === "user" && (message.display_kind === undefined || message.display_kind === "steer")) return null;
    if (message.role !== "tool" || message.name !== "clarify") continue;
    // The last questions asked, of any kind: one asked without waiting, unanswered, and not settled.
    // A row as an agent's history keeps it, Hermes's passed on as it is: `args` may be missing.
    const args: Record<string, unknown> | undefined = message.args ?? undefined;
    if (args?.async !== true || !isUnanswered(message.content) || kept.some((entry) => entry.id === message.tool_call_id)) return null;
    const asked: unknown[] = Array.isArray(args.questions) ? args.questions : [];
    const questions = asked.flatMap((entry, index): ClarifyQuestion[] => {
      const { question, choices } = (entry ?? {}) as { question?: unknown; choices?: unknown };
      if (typeof question !== "string" || question.trim() === "") return [];
      const offered = Array.isArray(choices) ? choices.filter((choice): choice is string => typeof choice === "string") : [];
      return [{ qid: `q${index}`, question, choices: offered, multiSelect: false }];
    });
    return questions.length > 0 ? { id: message.tool_call_id, questions } : null;
  }
  return null;
}

/** A row's result that says its questions went unanswered. */
function isUnanswered(content: string | undefined): boolean {
  try {
    return (JSON.parse(content ?? "null") as { unanswered?: unknown } | null)?.unanswered === true;
  } catch {
    return false;
  }
}

/**
 * The person's message for the answers given on the card: the one answer by itself for
 * one question, else each answered question with its answer under it. Null when none
 * was answered.
 */
export function answerMessage(questions: readonly ClarifyQuestion[], answers: Readonly<Record<string, string | null>>): string | null {
  const given = questions.flatMap((question) => {
    const answer = answers[question.qid]?.trim();
    return answer ? [{ question: question.question.trim(), answer }] : [];
  });
  if (given.length === 0) return null;
  if (questions.length === 1) return given[0].answer;
  return given.map(({ question, answer }) => `${question}\n${answer}`).join("\n\n");
}

/**
 * The args of their `clarify` row, wherever it is kept (live, and read back from Codex's
 * history): the questions with their options, and `async`, which marks them as asked
 * without waiting, for an app that keeps such a row in view.
 */
export function askedRowArgs(questions: readonly Pick<ClarifyQuestion, "question" | "choices">[]): Record<string, unknown> {
  return { questions: questions.map((question) => ({ question: question.question, choices: question.choices })), async: true };
}

/** The result of their row while their card is open: an app leaves such a row out, the card standing for it. */
export const askingResult = { responses: [], asking: true };

/**
 * The result of the thread's `clarify` row for them, as the app reads it from a stored
 * thread: the answers given on the card (none: skipped); null when the person answered
 * with a message of their own (shown as answered, the message after it); and
 * `unanswered` when they were taken back unanswered (a newer question, Stop), which an
 * app without the feature shows as skipped.
 */
export function askedResult(questions: readonly ClarifyQuestion[], answer: RequestAnswer): unknown {
  if (answer.kind === "withdrawn") return answer.reason === "replied" ? null : { responses: [], unanswered: true };
  return { responses: questions.map((question, index) => ({ question: question.question, user_response: cardAnswers(questions, answer)?.[index] ?? "" })) };
}

/**
 * Each question's answer given on the card, in order ("" skipped), for the thread's
 * record (`CardAnswer`): all "" for a card dismissed, none for one taken back.
 */
export function cardAnswers(questions: readonly ClarifyQuestion[], answer: RequestAnswer): string[] | undefined {
  if (answer.kind === "withdrawn") return undefined;
  const answers = answer.kind === "clarify" ? answer.answers : null;
  return questions.map((question) => answers?.[question.qid]?.trim() ?? "");
}
