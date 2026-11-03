import type { RequestPermissionRequestParams } from "@factory/droid-sdk/node";
import { contentText } from "./tools.ts";

/** A Spec replacement is proven by its approved tool ID, then its new root message. */
export class DroidHandoff {
  private readonly source: string;
  private readonly toolIds = new Set<string>();
  private readonly children = new Set<string>();
  private confirmed = false;
  target: string | null = null;
  failure: string | null = null;

  constructor(source: string) { this.source = source; }
  get expected(): boolean { return this.toolIds.size > 0; }
  /** The plan was approved for a new session, which has yet to be seen: the planning session's end is not the turn's. */
  get pending(): boolean { return this.confirmed && !this.target && !this.failure; }

  expect(params: RequestPermissionRequestParams): void {
    for (const { toolUse, details } of params.toolUses) if (details.type === "exit_spec_mode") this.toolIds.add(toolUse.id);
  }

  observe(params: Record<string, unknown>): string | null {
    const raw = params.notification;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const n = raw as Record<string, unknown>;
    if (n.type === "child_session_available" && typeof n.childSessionId === "string") this.children.add(n.childSessionId);
    if (n.type === "tool_progress_update" && n.update && typeof n.update === "object" && "subagentSessionId" in n.update
      && typeof n.update.subagentSessionId === "string") this.children.add(n.update.subagentSessionId);
    if (!this.expected || this.target || this.failure) return null;
    if (n.type === "tool_result" && params.sessionId === this.source && typeof n.toolUseId === "string"
      && this.toolIds.has(n.toolUseId) && n.isError !== true) {
      try {
        const result = JSON.parse(contentText(n.content));
        this.confirmed = result?.approved === true && result?.handoff?.isNewSession === true;
      } catch { /* No matching structured handoff: keep the source mapping. */ }
    }
    if (!this.confirmed || n.type !== "create_message" || typeof params.sessionId !== "string" || !params.sessionId
      || params.sessionId === this.source || this.children.has(params.sessionId)) return null;
    const message = n.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    const user = message as Record<string, unknown>;
    if (user.role !== "user" || user.parentId !== "root" || typeof user.id !== "string" || !user.id || user.visibility === "llm_only") return null;
    this.target = params.sessionId;
    return this.target;
  }
}
