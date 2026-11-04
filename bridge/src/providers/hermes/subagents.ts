import type { SubagentInfo, SubagentStatus } from "../types.ts";
import type { Frame } from "./client.ts";

// The agents Hermes's `delegate_task` starts, as the subagents line shows them (feature
// subagents), from its `subagent.*` events: each names the child by `subagent_id`, and
// `parent_id` the child that started it, for a child's own children. One the thread's
// agent started runs in the background: Hermes's tool answers at once, and the child's
// result comes back as a turn of its own once it is done. A child's children are its
// own, within its run. Each can be stopped by itself (`subagent.interrupt`).

/** How Hermes says a child ended, as the line shows it. */
const endings: Record<string, SubagentStatus> = { completed: "completed", interrupted: "stopped", failed: "failed", error: "failed", timeout: "failed" };

export class HermesSubagents {
  private readonly known = new Map<string, SubagentInfo>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * The child a `subagent.*` event tells of, as it stands now; null for one without an id
   * (an older Hermes), news the line does not show (a child's reasoning), and news of a
   * child that has ended.
   */
  news(type: string, payload: Frame): SubagentInfo | null {
    const id = typeof payload.subagent_id === "string" ? payload.subagent_id : "";
    if (id === "" || type === "subagent.thinking") return null;
    let info = this.known.get(id);
    if (info && info.status !== "running") return null;
    if (!info) {
      const parent = typeof payload.parent_id === "string" && payload.parent_id !== "" ? payload.parent_id : undefined;
      info = {
        id,
        kind: "agent",
        goal: oneLine(payload.goal) || oneLine(payload.text),
        status: "running",
        startedAt: this.now(),
        background: parent === undefined && !(typeof payload.depth === "number" && payload.depth > 0),
        stoppable: true,
        ...(parent ? { parent } : {}),
      };
      this.known.set(id, info);
    }
    if (typeof payload.model === "string" && payload.model !== "") info.model = payload.model;
    if (Number.isInteger(payload.tool_count)) info.toolUses = payload.tool_count;
    switch (type) {
      case "subagent.tool":
        if (typeof payload.tool_name === "string" && payload.tool_name !== "") info.tool = payload.tool_name;
        if (oneLine(payload.text) !== "") info.summary = oneLine(payload.text);
        break;
      case "subagent.complete": {
        info.status = endings[String(payload.status)] ?? "completed";
        info.endedAt = this.now();
        const result = typeof payload.summary === "string" && payload.summary.trim() !== "" ? payload.summary.trim() : stringOf(payload.text).trim();
        if (result !== "") info.result = result;
        const tokens = [payload.input_tokens, payload.output_tokens].filter((count): count is number => Number.isInteger(count));
        if (tokens.length > 0) info.tokens = tokens.reduce((sum, count) => sum + count, 0);
        delete info.summary;
        break;
      }
    }
    return { ...info };
  }

  /** Whether `id` is a child Hermes still runs, as far as its events said. */
  running(id: string): boolean {
    return this.known.get(id)?.status === "running";
  }

  /** Whether any child still runs, as far as their events said: one may outlive the turn that started it. */
  anyRunning(): boolean {
    return [...this.known.values()].some((info) => info.status === "running");
  }

  /** Ends each child still running as stopped, for a Hermes that no longer has them (another runtime): each as it stands now. */
  stopAll(): SubagentInfo[] {
    const stopped: SubagentInfo[] = [];
    for (const info of this.known.values()) {
      if (info.status !== "running") continue;
      info.status = "stopped";
      info.endedAt = this.now();
      delete info.summary;
      stopped.push({ ...info });
    }
    return stopped;
  }
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function oneLine(value: unknown): string {
  return stringOf(value).trim().split("\n")[0].trim();
}
