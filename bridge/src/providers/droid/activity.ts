import { createHash } from "node:crypto";
import type { DroidStreamEvent } from "@factory/droid-sdk/node";
import { outputTail } from "../liveOutput.ts";
import type { ProviderEvent } from "../types.ts";

/** Thinking tokens are included in output, not an additional charge here. */
export function tokenTotal(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const values = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]
    .map((key) => (usage as Record<string, unknown>)[key]);
  if (!values.some((value) => typeof value === "number")) return undefined;
  if (values.some((value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) return undefined;
  const total = values.reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
  return Number.isFinite(total) ? total : undefined;
}

const workingText: Record<string, string> = {
  idle: "", thinking: "Thinking", streaming_assistant_message: "Replying",
  waiting_for_tool_confirmation: "Waiting for approval", executing_tool: "Running tool",
  compacting_conversation: "Compacting conversation",
};

interface Progress {
  /** The id the app knows the call by (`gatewayId`). */
  as: string;
  output?: string;
  progress?: string;
  truncated: boolean;
  update?: string;
  emittedAt?: number;
  timer?: NodeJS.Timeout;
  pending?: boolean;
}

export { outputTail };

/** Turn-local activity. Output stays bounded and replaces earlier snapshots. */
export class DroidActivity {
  private readonly emit: (event: ProviderEvent) => void;
  private readonly baseline: number | null;
  private readonly tools = new Map<string, Progress>();
  private readonly notices = new Set<string>();
  private state: string | undefined;
  private tokens: number | undefined;

  constructor(emit: (event: ProviderEvent) => void, baseline: number | null) {
    this.emit = emit;
    this.baseline = baseline;
  }

  /** A call Droid calls `id` begins; the app knows it as `as`. */
  start(id: string, as = id): void { this.tools.set(id, { as, truncated: false }); }
  /** The end of call `id`'s output as far as it came, sent or still waiting its turn to go out. */
  output(id: string): string | undefined { return this.tools.get(id)?.output; }
  end(id: string): void {
    const tool = this.tools.get(id);
    if (tool?.timer) clearTimeout(tool.timer);
    if (tool?.pending) this.flush(id, tool);
    this.tools.delete(id);
  }

  private flush(id: string, tool: Progress): void {
    tool.pending = false;
    tool.emittedAt = Date.now();
    this.emit({ type: "tool.progress", id: tool.as,
      ...(tool.output !== undefined ? { output: tool.output, outputTruncated: tool.truncated } : {}),
      ...(tool.progress !== undefined ? { progress: tool.progress } : {}) });
  }

  private publish(id: string, tool: Progress): void {
    tool.pending = true;
    const delay = tool.emittedAt === undefined ? 0 : Math.max(0, tool.emittedAt + 250 - Date.now());
    if (delay === 0) {
      if (tool.timer) clearTimeout(tool.timer);
      tool.timer = undefined;
      this.flush(id, tool);
    } else {
      tool.timer ??= setTimeout(() => {
        tool.timer = undefined;
        this.flush(id, tool);
      }, delay);
      tool.timer.unref();
    }
  }

  private notice(key: string, level: "info" | "warn" | "error", text: string): void {
    if (this.notices.has(key)) return;
    this.notices.add(key);
    this.emit({ type: "notice", level, text });
  }

  retry(notification: Record<string, unknown>): void {
    const attempt = typeof notification.attempt === "number" ? ` (attempt ${notification.attempt})` : "";
    this.notice(JSON.stringify(["retry", notification.attempt, notification.timestamp]), "warn", `Droid is retrying the model request${attempt}.`);
  }

  accept(event: DroidStreamEvent): void {
    switch (event.type) {
      case "working_state_changed":
        if (this.state !== event.state) {
          this.state = event.state;
          this.emit({ type: "working", state: event.state, text: workingText[event.state] ?? "Working" });
        }
        break;
      case "token_usage_update": {
        const total = tokenTotal(event);
        if (total === undefined || this.baseline === null) break;
        const tokens = Math.max(0, total - this.baseline);
        if (tokens !== this.tokens) {
          this.tokens = tokens;
          this.emit({ type: "turn.usage", usage: { tokens } });
        }
        break;
      }
      case "tool_progress": {
        const previous = this.tools.get(event.toolUseId);
        if (!previous) break;
        const update = event.update;
        // A repeated piece of output must not be added twice. Whole output replaces what
        // was kept, so a repeat of it changes nothing and needs no fingerprint (which
        // would read all of it again).
        const signature = update.fullOutput === undefined
          ? createHash("sha256").update(JSON.stringify([update, event.content])).digest("hex") : undefined;
        if (signature !== undefined && previous.update === signature) break;
        previous.update = signature;
        const terminal = event.toolName === "Execute";
        let output = previous.output;
        let truncated = previous.truncated;
        if (update.fullOutput !== undefined) {
          const tail = outputTail(update.fullOutput);
          output = tail.output;
          truncated = tail.truncated;
        } else if (terminal && (update.text || event.content)) {
          const added = update.text || event.content;
          const whole = (output ?? "") + added;
          const tail = outputTail(whole);
          output = tail.output;
          truncated ||= tail.truncated;
        }
        const status = update.status ?? update.error ?? (!terminal ? update.text || event.content : undefined);
        const progress = status === undefined ? previous.progress : status.slice(0, 2000);
        if (output === previous.output && progress === previous.progress && truncated === previous.truncated) break;
        Object.assign(previous, { output, progress, truncated });
        this.publish(event.toolUseId, previous);
        break;
      }
      case "hook": {
        // As with the other agents, a hook that runs fine is not shown; only a failing one is.
        if (event.status !== "error" && (event.exitCode === undefined || event.exitCode === 0)) break;
        const output = event.suppressOutput ? "" : [event.stdout, event.stderr].filter(Boolean).join("\n").slice(0, 2000);
        const name = [event.eventName, event.matcher].filter(Boolean).join(" / ") || "Hook";
        const code = event.exitCode === undefined ? "" : ` (exit ${event.exitCode})`;
        this.notice(`hook:${event.hookId}:${event.command}:${event.status}`, "error",
          `${name}: ${event.status}${code}${output ? `\n${output}` : ""}`);
        break;
      }
      case "mcp_status_changed":
        for (const server of event.servers) {
          let level: "info" | "warn" | "error" = "info";
          if (server.requiresAuth) level = "warn";
          if (server.status === "failed") level = "error";
          this.notice(`mcp:${server.name}:${server.status}:${server.requiresAuth}`, level,
            `MCP ${server.name}: ${server.status}${server.requiresAuth ? ". Sign in through Droid on the host." : ""}`);
        }
        break;
      case "mcp_auth_required":
        // Never copy OAuth URLs, state, tokens or free-form auth messages into history.
        this.notice(`auth:${event.serverName}`, "warn", `MCP ${event.serverName} needs authentication. Sign in through Droid on the host.`);
        break;
      case "mcp_auth_completed":
        this.notice(`auth:${event.serverName}:${event.outcome}`, event.outcome === "success" ? "info" : "warn",
          `MCP ${event.serverName} authentication: ${event.outcome}.`);
        break;
    }
  }

  finish(): void {
    for (const tool of this.tools.values()) if (tool.timer) clearTimeout(tool.timer);
    this.tools.clear();
    if (this.state !== undefined && this.state !== "idle") {
      this.state = "idle";
      this.emit({ type: "working", state: "idle", text: "" });
    }
  }
}
