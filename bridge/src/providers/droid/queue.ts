import type { Prompt, SessionSink } from "../types.ts";
import { AddUserMessageRequestParamsSchema } from "@factory/droid-sdk/node";
import type { DroidHandle } from "./sdk.ts";

/** How many steering messages that left `pending` without Droid's receipt are kept for one that comes late (`settled`). */
const settledKept = 64;

const finishedError = "The Droid turn ended before this steering message was confirmed. Review it and try again.";

/** Messages handed to the active SDK stream, identified by RPC ID, never their text. */
export class DroidQueue {
  private readonly pending = new Map<string, Prompt>();
  /**
   * Steering messages that left `pending` without Droid's receipt: failed (Portals shows
   * them failed, with Try again), or taken back with Droid's `{}`, which Droid also answers
   * for one it had taken already. Droid's receipt for one may still come (it takes what is
   * still queued once its loop is idle): it is then kept as taken, so a restart never sends
   * it again, and the person is told (`notification`). The latest few.
   */
  private readonly settled = new Map<string, Prompt>();
  private readonly emit: SessionSink["emit"];
  private readonly consumed: (requestId: string, prompt: Prompt) => void;

  constructor(
    emit: SessionSink["emit"],
    consumed: (requestId: string, prompt: Prompt) => void,
  ) { this.emit = emit; this.consumed = consumed; }

  async add(handle: DroidHandle, prompt: Prompt, requestId: string): Promise<boolean> {
    // File references and image bytes must stay together on the bridge's durable list.
    if (prompt.images.length || prompt.files?.length) return false;
    this.pending.set(requestId, prompt);
    try {
      await handle.addUserMessage(AddUserMessageRequestParamsSchema.parse({
        messageId: requestId, text: prompt.text, queuePlacement: "end_of_turn",
      }), requestId);
    } catch {
      // The request may have reached Droid even when its acknowledgement was lost.
      this.fail(requestId, "Droid could not confirm this steering message. It was not sent again automatically.");
    }
    return true;
  }

  async delete(handle: DroidHandle, requestId: string): Promise<boolean> {
    if (!this.pending.has(requestId)) return false;
    // The SDK types this action with an enum it does not export.
    type Delete = Exclude<Parameters<DroidHandle["resolveQueuedUserMessage"]>[0], { queuePlacement: unknown }>;
    await handle.resolveQueuedUserMessage({ action: "delete" as Delete["action"], requestId });
    // Droid also returns {} for an already-consumed ID. Its consumption wins the race: its
    // receipt comes before its answer, and is taken in, in order (`notification`). Should
    // one come later all the same, it is reconciled (`settled`).
    const prompt = this.pending.get(requestId);
    if (!prompt) return false;
    this.pending.delete(requestId);
    this.keepSettled(requestId, prompt);
    return true;
  }

  notification(notification: Record<string, unknown>): void {
    if (notification.type === "create_message") {
      const id = notification.requestId;
      const message = notification.message;
      if (typeof id !== "string" || !message || typeof message !== "object" || !("role" in message)) return;
      // Droid refused it (a message too large for the model, say): a note for the person,
      // tied to its request. It fails now, with Droid's reason, not at the turn's end.
      if (message.role === "system") {
        const reason = refusal(message);
        if (reason !== undefined) this.fail(id, `Droid did not take this steering message: ${reason}`);
        return;
      }
      if (message.role !== "user") return;
      const prompt = this.pending.get(id);
      if (!prompt) {
        // Taken by Droid after Portals had failed it or taken it back: Droid has it, and it
        // is kept as taken, so a restart never sends it again; Try again would send it twice.
        const late = this.settled.get(id);
        if (!late) return;
        this.settled.delete(id);
        this.consumed(id, late);
        this.emit({ type: "queue.taken", requestId: id, prompt: late });
        this.emit({ type: "notice", level: "warn", text: "Droid took a steering message after Portals had marked it failed or taken it back. Droid has it: do not send it again." });
        return;
      }
      this.pending.delete(id);
      this.consumed(id, prompt);
      this.emit({ type: "queue.consumed", requestId: id });
    } else if (notification.type === "queued_messages_discarded") {
      const error = "Droid discarded a pending steering message. Review it and try again.";
      if (typeof notification.requestId === "string") this.fail(notification.requestId, error);
      else this.finish(error);
    }
  }

  private fail(requestId: string, error: string): void {
    const prompt = this.pending.get(requestId);
    if (!prompt) return;
    this.pending.delete(requestId);
    this.keepSettled(requestId, prompt);
    this.emit({ type: "queue.failed", requestId, error });
    this.emit({ type: "notice", level: "warn", text: error });
  }

  private keepSettled(requestId: string, prompt: Prompt): void {
    this.settled.delete(requestId);
    this.settled.set(requestId, prompt);
    if (this.settled.size > settledKept) this.settled.delete(this.settled.keys().next().value!);
  }

  finish(error = finishedError): void {
    for (const id of this.pending.keys()) this.fail(id, error);
  }

  /**
   * The turn ended with steering messages Droid has not taken. Droid takes what is still
   * queued once its loop is idle (recent-16), so each is first taken back from Droid's
   * queue: one whose receipt comes before Droid's answer was taken, and goes on as taken
   * (`queue.consumed`); the others fail, and Droid no longer has them, so Try again sends
   * each once. With no connection to ask, or no answer, they fail at once as before (a
   * receipt that comes later all the same is reconciled, `settled`).
   */
  async settle(handle: DroidHandle | undefined, error = finishedError): Promise<void> {
    const ids = [...this.pending.keys()];
    if (ids.length === 0) return;
    if (!handle?.connected()) {
      this.finish(error);
      return;
    }
    // The SDK types this action with an enum it does not export.
    type Delete = Exclude<Parameters<DroidHandle["resolveQueuedUserMessage"]>[0], { queuePlacement: unknown }>;
    await Promise.all(ids.map(async (requestId) => {
      try {
        await handle.resolveQueuedUserMessage({ action: "delete" as Delete["action"], requestId });
      } catch {
        // No answer: Droid may still take it, which is reconciled if it does (`settled`).
      }
      // Its receipt came first: taken (no longer pending). Else it fails, Droid not having it.
      this.fail(requestId, error);
    }));
  }
}

/** What Droid says in a note for the person that is an error ("Error: …"), without its "Error:". */
function refusal(message: object): string | undefined {
  const note = message as { visibility?: unknown; content?: unknown };
  if (note.visibility !== "user_only" || !Array.isArray(note.content)) return undefined;
  const text = note.content.flatMap((block: unknown) => {
    const item = block as { type?: unknown; text?: unknown } | null;
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
  return text.startsWith("Error:") ? text.replace(/^Error:\s*/, "") : undefined;
}
