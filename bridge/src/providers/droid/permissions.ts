import { ToolConfirmationOutcome, type RequestPermissionHandlerResult, type RequestPermissionRequestParams } from "@factory/droid-sdk/node";
import type { SessionSink, ThreadMode } from "../types.ts";
import { requestPermission } from "./requests.ts";

interface Pending {
  params: RequestPermissionRequestParams;
  abort: AbortController;
}

/** Tool-use IDs settle the same card on every device, including another SDK surface. */
export class DroidPermissions {
  private readonly pending = new Set<Pending>();
  private readonly sink: SessionSink;
  private readonly selected: (params: RequestPermissionRequestParams, outcome: ToolConfirmationOutcome) => void;

  constructor(sink: SessionSink, selected: DroidPermissions["selected"]) {
    this.sink = sink;
    this.selected = selected;
  }

  /** `subagent`: the background subagent that asks, whose card the turn's end does not take back. */
  async ask(params: RequestPermissionRequestParams, signal: AbortSignal, startsIn: ThreadMode, cwd: string, subagent?: string): Promise<RequestPermissionHandlerResult> {
    const entry = { params, abort: new AbortController() };
    this.pending.add(entry);
    try {
      return await requestPermission(params, this.sink, AbortSignal.any([signal, entry.abort.signal]), startsIn,
        (outcome) => this.selected(params, outcome), cwd, subagent);
    } finally { this.pending.delete(entry); }
  }

  notification(notification: Record<string, unknown>): void {
    if (notification.type !== "permission_resolved" || !Array.isArray(notification.toolUseIds)) return;
    const ids = new Set(notification.toolUseIds.filter((id) => typeof id === "string"));
    for (const entry of this.pending) {
      if (!entry.params.toolUses.some(({ toolUse }) => ids.has(toolUse.id))) continue;
      this.pending.delete(entry);
      entry.abort.abort("resolved");
      const outcome = entry.params.options.find((option) => option.value === notification.selectedOption)?.value;
      if (outcome && outcome !== ToolConfirmationOutcome.Cancel && outcome !== ToolConfirmationOutcome.ProceedEdit) this.selected(entry.params, outcome);
    }
  }
}
