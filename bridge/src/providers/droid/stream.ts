import { randomUUID } from "node:crypto";
import type { DroidStreamEvent } from "@factory/droid-sdk/node";
import type { ProviderEvent, StoredMessage } from "../types.ts";
import { gatewayResult, gatewayTool, type DroidTool } from "./tools.ts";
import { DroidActivity } from "./activity.ts";

interface Reply {
  text: string;
  reasoning: string;
  stored: boolean;
}

/** Whether a call runs on in the background after its first result (a launch receipt), its final result to come later. */
export function runsInBackground(name: string, input: Record<string, unknown>): boolean {
  return name === "Execute" && (input.fireAndForget === true || input.run_in_background === true);
}

/**
 * The id the app knows a call by. Droid's is the model's, which some models number afresh
 * in each answer ("call_0"): a background command's final result, which comes later and
 * outside its turn, would go to a newer call with the same id, and a history could join
 * two such commands into one row. So a background call is given an id that cannot be
 * another's, Droid's with a random end; the others keep Droid's.
 */
export function gatewayId(droidId: string, name: string, input: Record<string, unknown>): string {
  return runsInBackground(name, input) ? `${droidId}#bg-${randomUUID().slice(0, 8)}` : droidId;
}

/** A call a turn ended under, with no result yet (`DroidStream.finish`). */
export interface OpenCall {
  /** Droid's id for it. */
  droidId: string;
  /** The app's (`gatewayId`). */
  id: string;
  tool: DroidTool;
  started: number;
}

/** One turn's translation. Final SDK messages supplement deltas, not repeat them. */
export class DroidStream {
  private readonly emit: (event: ProviderEvent) => void;
  private readonly messages: StoredMessage[];
  /** The thread's folder: tool diffs name a file in it by its path there. */
  private readonly cwd: string;
  private readonly replies = new Map<string, Reply>();
  /** The calls running, by Droid's id: each with the id the app knows it by (`gatewayId`). */
  private readonly calls = new Map<string, { tool: DroidTool; started: number; id: string }>();
  /** Told the id a background call is given (`gatewayId`), so its final result, which comes later and outside the turn, goes to its row. */
  private readonly named: (droidId: string, id: string) => void;
  private openText = "";
  private open: { id: string; type: "text" | "reasoning"; text: string }[] = [];
  private output = false;
  private readonly activity: DroidActivity;
  error: string | undefined;
  result: Extract<DroidStreamEvent, { type: "result" }> | undefined;

  constructor(messages: StoredMessage[], emit: (event: ProviderEvent) => void, cwd: string, tokenBaseline: number | null = null,
    named: (droidId: string, id: string) => void = () => undefined) {
    this.messages = messages;
    this.named = named;
    this.emit = emit;
    this.cwd = cwd;
    this.activity = new DroidActivity(emit, tokenBaseline);
  }

  notification(notification: Record<string, unknown>): void {
    if (notification.type === "llm_retry") this.activity.retry(notification);
  }

  private reply(id: string): Reply {
    let reply = this.replies.get(id);
    if (!reply) { reply = { text: "", reasoning: "", stored: false }; this.replies.set(id, reply); }
    return reply;
  }

  private text(id: string, text: string): void {
    if (!text) return;
    this.output = true;
    this.openText += text;
    this.open.push({ id, type: "text", text });
    this.emit({ type: "text", text });
  }

  private reasoning(id: string, text: string): void {
    if (!text) return;
    this.open.push({ id, type: "reasoning", text });
    this.emit({ type: "reasoning", text });
  }

  private keep(reply: Reply): void {
    if (reply.stored || (!reply.text && !reply.reasoning)) return;
    this.messages.push({ role: "assistant", text: reply.text, timestamp: Date.now(), ...(reply.reasoning ? { reasoning: reply.reasoning } : {}) });
    reply.stored = true;
  }

  accept(event: DroidStreamEvent): void {
    this.activity.accept(event);
    switch (event.type) {
      case "tool_call_delta":
        // Cumulative, possibly incomplete input. Only the canonical tool_call opens
        // a row; argument snapshots are not tool output.
        break;
      case "assistant_text_delta":
        this.reply(event.messageId).text += event.text;
        this.text(event.messageId, event.text);
        break;
      case "thinking_text_delta":
        this.reply(event.messageId).reasoning += event.text;
        this.reasoning(event.messageId, event.text);
        break;
      case "assistant": {
        const reply = this.reply(event.message.id);
        if (reply.stored) break;
        const missing = event.text.startsWith(reply.text) ? event.text.slice(reply.text.length) : reply.text ? "" : event.text;
        this.text(event.message.id, missing);
        reply.text += missing;
        const thinking = event.message.content.flatMap((block) => block.type === "thinking" ? [block.thinking] : []).join("\n");
        const rest = thinking.startsWith(reply.reasoning) ? thinking.slice(reply.reasoning.length) : reply.reasoning ? "" : thinking;
        this.reasoning(event.message.id, rest);
        reply.reasoning += rest;
        this.keep(reply);
        break;
      }
      case "assistant_message_retracted": {
        // Droid takes back a message it streamed, as when a model call is retried: its
        // text was shown live but is not kept, nor counted as text before a tool.
        const reply = this.replies.get(event.messageId);
        if (!reply || reply.stored) break;
        this.replies.delete(event.messageId);
        this.open = this.open.filter((piece) => piece.id !== event.messageId);
        this.openText = this.open.filter((piece) => piece.type === "text").map((piece) => piece.text).join("");
        this.output = [...this.replies.values()].some((reply) => reply.text !== "");
        this.emit({ type: "assistant.replace", text: this.openText,
          reasoning: this.open.filter((piece) => piece.type === "reasoning").map((piece) => piece.text).join("") });
        break;
      }
      case "tool_call": {
        if (this.calls.has(event.toolUseId)) break;
        if (this.openText) {
          this.emit({ type: "commentary", text: this.openText, alreadyStreamed: true });
          this.openText = "";
        }
        this.open = [];
        // The SDK gives a message's tool calls before the message itself, so what was
        // streamed before the tool is kept first, in the order it was said.
        for (const reply of this.replies.values()) this.keep(reply);
        const tool = gatewayTool(event.name, event.input);
        const id = gatewayId(event.toolUseId, event.name, event.input);
        if (id !== event.toolUseId) this.named(event.toolUseId, id);
        this.calls.set(event.toolUseId, { tool, started: Date.now(), id });
        this.activity.start(event.toolUseId, id);
        this.emit({ type: "tool.start", id, ...tool });
        this.messages.push({ role: "tool", ...tool, tool_call_id: id, timestamp: Date.now() });
        break;
      }
      case "tool_result": {
        const call = this.calls.get(event.toolUseId);
        if (!call) break;
        this.calls.delete(event.toolUseId);
        this.activity.end(event.toolUseId);
        const result = gatewayResult(call.tool, event.content, event.isError, this.cwd);
        this.emit({ type: "tool.end", id: call.id, ...call.tool, result, durationSeconds: (Date.now() - call.started) / 1000 });
        const message = this.messages.findLast((message) => message.role === "tool" && message.tool_call_id === call.id);
        if (message?.role === "tool") message.content = JSON.stringify(result);
        break;
      }
      case "error":
        this.error = event.message;
        this.emit({ type: "notice", level: "error", text: event.message });
        break;
      case "session_title_updated":
        // Taken from the session's notifications (DroidSession.droidNamed), which also come after a turn.
        break;
      case "result":
        this.result = event;
        if (!this.output && event.text) {
          const reply = this.reply("result");
          reply.text = event.text;
          this.text("result", event.text);
        }
        break;
    }
  }

  /**
   * The turn is over: what it said is kept, and each call still open ends without a result.
   * `open` is told of those calls (a turn that ended as it should: a call a Script ran in
   * the background, whose result comes after it), so that a result that comes later goes to
   * the call's row; a stop's keep what they had printed.
   */
  finish(open?: (calls: OpenCall[]) => void): void {
    for (const reply of this.replies.values()) this.keep(reply);
    const left = [...this.calls].map(([droidId, { tool, id, started }]) => ({ droidId, id, tool, started }));
    for (const [use, { tool, id }] of this.calls) {
      // What it printed live stays its output: a command stopped mid-run is shown with
      // what it had printed, not with that alone in its place.
      const output = this.activity.output(use);
      const result = { success: false, error: "The turn ended before this tool reported a result.", ...(output ? { output } : {}) };
      this.emit({ type: "tool.end", id, ...tool, result });
      const message = this.messages.findLast((message) => message.role === "tool" && message.tool_call_id === id);
      if (message?.role === "tool") message.content = JSON.stringify(result);
    }
    this.calls.clear();
    this.activity.finish();
    // After their ends here: a result that came already, while the turn closed, replaces them.
    open?.(left);
  }
}
