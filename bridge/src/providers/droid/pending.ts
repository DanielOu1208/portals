import { randomUUID } from "node:crypto";
import { object } from "./desk.ts";

export const cancelledForkTool = "Tool cancelled: This call was not finished in the source and was cancelled in this fork. It was not run.";
const pendingResult = "__TOOL_RESULT_PENDING__";

/** Native load_session automatically recovers these calls; inspect every message, including hidden ones. */
export function unfinishedDroidTools(text: string): Map<string, string> {
  const calls = new Map<string, string>();
  const pending = new Map<string, string>();
  for (const line of text.split("\n").slice(1)) {
    let entry: Record<string, unknown> | undefined;
    try { entry = object(JSON.parse(line)); } catch { continue; }
    const message = object(entry?.message);
    if (entry?.type !== "message" || !Array.isArray(message?.content)) continue;
    for (const value of message.content) {
      const block = object(value);
      if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        calls.set(block.id, block.name);
        pending.set(block.id, block.name);
      } else if (block?.type === "tool_result") {
        const id = block.toolUseId ?? block.tool_use_id;
        if (typeof id !== "string" || !calls.has(id)) continue;
        if (block.content === pendingResult || block.content == null) pending.set(id, calls.get(id)!);
        else pending.delete(id);
      }
    }
  }
  return pending;
}

/** Settle only the throwaway copy, before Droid can load it and resume any tool. */
export function settledDroidSnapshot(text: string): string {
  const pending = unfinishedDroidTools(text);
  if (!pending.size) return text;
  const now = Date.now();
  const id = randomUUID();
  let parentId: string | undefined;
  let seq = -1;
  for (const line of text.split("\n")) {
    try {
      const entry = object(JSON.parse(line));
      if (entry?.type === "message" && typeof entry.id === "string") parentId = entry.id;
      if (typeof entry?.seq === "number") seq = Math.max(seq, entry.seq);
    } catch { /* An incomplete trailing source line is not part of its saved history. */ }
  }
  return `${text.trimEnd()}\n${JSON.stringify({
    type: "message", id, parentId, seq: seq + 1, timestamp: new Date(now).toISOString(),
    message: {
      role: "user",
      content: [...pending.keys()].map((tool_use_id) => ({ type: "tool_result", tool_use_id, content: cancelledForkTool, is_error: true })),
    },
  })}\n`;
}
