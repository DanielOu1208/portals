import type { AgentRequest, RequestAnswer } from "../types.ts";
import type { PiUiRequest, PiUiResponse } from "./protocol.ts";

// What one of the user's Pi extensions asks (`ctx.ui.select`, `confirm`, `input`, `editor`), as
// a question card on the phone, and the card's answer as the record Pi waits for
// (Pi's docs/rpc-extension-ui.md). Pi has no approvals of its own; an extension that
// guards commands asks with one of these.

const dialogs = new Set(["select", "confirm", "input", "editor"]);

/** The choices of a `confirm`. */
const yes = "Yes";
const no = "No";

/** True for a request that waits for an answer; `notify`, `setStatus` and the like wait for none. */
export function isDialog(request: PiUiRequest): boolean {
  return typeof request.id === "string" && request.id !== "" && dialogs.has(request.method ?? "");
}

function said(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The dialog as a card of one question; null for a request that is no dialog. */
export function dialogCard(request: PiUiRequest): AgentRequest | null {
  if (!isDialog(request)) return null;
  const title = said(request.title);
  let question = title;
  let choices: string[] = [];
  switch (request.method) {
    case "select":
      question = title || "Choose one";
      choices = Array.isArray(request.options) ? request.options.filter((option): option is string => typeof option === "string" && option !== "") : [];
      break;
    case "confirm":
      question = [title, said(request.message)].filter((part) => part !== "").join("\n\n") || "Go ahead?";
      choices = [yes, no];
      break;
    case "input":
      // No choices: an answer is typed.
      question = title || "Pi asks for a line of text";
      break;
    case "editor": {
      // The card cannot start from text, so the text to edit is shown and a new one is typed.
      const prefill = typeof request.prefill === "string" ? request.prefill.trimEnd() : "";
      question = [title || "Pi asks for some text", prefill].filter((part) => part !== "").join("\n\n");
      break;
    }
  }
  return { kind: "clarify", questions: [{ qid: request.id!, question, choices, multiSelect: false }] };
}

/** The record that dismisses a dialog: Pi's extension gets no value (false, for a `confirm`). */
export function cancelled(id: string): PiUiResponse {
  return { type: "extension_ui_response", id, cancelled: true };
}

/**
 * The card's answer as Pi's record. A card nobody answered (dismissed, withdrawn by
 * Stop, closed by its turn's end) cancels the dialog. So does something typed in place
 * of one of a `select`'s options: Pi's extension expects one of its own.
 */
export function dialogAnswer(request: PiUiRequest, answer: RequestAnswer): PiUiResponse {
  const id = request.id ?? "";
  const given = answer.kind === "clarify" ? answer.answers?.[id] : null;
  if (typeof given !== "string") return cancelled(id);
  switch (request.method) {
    case "select":
      return Array.isArray(request.options) && request.options.includes(given) ? { type: "extension_ui_response", id, value: given } : cancelled(id);
    case "confirm":
      return { type: "extension_ui_response", id, confirmed: given.trim().toLowerCase() === yes.toLowerCase() };
    default:
      return { type: "extension_ui_response", id, value: given };
  }
}
