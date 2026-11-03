import { basename } from "node:path";
import { askedRowArgs } from "../../sessions/answers.ts";
import type { StoredMessage } from "../types.ts";
import { CodexAgents } from "./agents.ts";
import { asyncQuestions } from "./requests.ts";
import { gatewayResult, gatewayTool } from "./tools.ts";
import type { Thread, Turn } from "./types/index.ts";

// A Codex thread as `thread/read {includeTurns: true}` returns it, in the shape
// `session.resume` returns (docs/gateway-protocol.md, section 8): the user's messages,
// each of Codex's messages with the reasoning before it, and one tool message per work
// item with its result. Codex keeps whole items, so history has the same rows and
// diffs as the live turn had.
//
// A `contextCompaction` item marks where Codex summarised the thread (a `compaction`
// message). In a turn with no message of the user's it is what a `/compact` started,
// which Codex stores without the command: the turn opens with it, as it did live. Such
// a turn still running has no item yet (Codex keeps an item once it is done), so it is
// the command alone. History does not say how full the context was before.
//
// A call about the thread's sub-agents names those it was about as it did live, from the
// items before it (`CodexAgents.calledAbout`): by nickname when the session has read them
// from the sub-agents' own threads (`subagentsCalledIn`), else by what each was asked to do.
//
// Questions Codex asked without waiting (./requests.ts) are a `clarify` tool's row, as the
// bridge keeps them live, never their raw text: answered when a message of the user's
// came after them, which Codex took as the answer (and which shows after it), else
// `unanswered`.

type Item = Record<string, any>;

/** The Codex command the bridge carries out for the app (`CodexProvider.commands`): `thread/compact/start`. */
export const compactCommand = "compact";

/** A user message's text as the bridge stores one it sends: the text, then one `@image:<name>` line per image. */
export function userInputText(content: unknown): string {
  const lines: string[] = [];
  const images: string[] = [];
  for (const entry of Array.isArray(content) ? (content as Item[]) : []) {
    if (entry?.type === "text" && typeof entry.text === "string" && entry.text !== "") lines.push(entry.text);
    else if (entry?.type === "localImage" && typeof entry.path === "string") images.push(`@image:${basename(entry.path)}`);
    else if (entry?.type === "image") images.push(`@image:image-${images.length + 1}.jpg`);
  }
  return [...lines, ...images].join("\n");
}

export interface CodexHistory {
  messages: StoredMessage[];
  /**
   * The turn still running, if the last one is: its id, the last message sent into it as
   * stored (the one that opened it, or one steered in since, which the app shows as
   * opening a turn of its own), and its items so far.
   */
  running: { turnId: string; user: string; items: Item[] } | null;
  /** By turn id: how many of `messages` come up to the end of that turn's own. */
  ends: Map<string, number>;
}

/**
 * The thread's turns as stored messages. `active` says whether Codex has the thread
 * running now; a last turn still in progress in a thread that is not running was cut
 * off (Codex stopped), and is shown as interrupted. `nicknames`: what Codex calls the
 * sub-agents its calls name, by thread id, read from their own threads.
 */
export function historyFromThread(thread: Pick<Thread, "turns">, cwd: string, active: boolean, nicknames?: ReadonlyMap<string, string>): CodexHistory {
  const messages: StoredMessage[] = [];
  let running: CodexHistory["running"] = null;
  const ends = new Map<string, number>();
  const turns = (thread.turns ?? []) as Turn[];
  // The thread's sub-agents as each item found them.
  const agents = new CodexAgents(() => 0);
  // The last questions asked without waiting, until a message of the user's answers them.
  let asked: Extract<StoredMessage, { role: "tool" }> | null = null;
  turns.forEach((turn, index) => {
    const from = messages.length;
    const last = index === turns.length - 1;
    const start = typeof turn.startedAt === "number" ? turn.startedAt : 0;
    const end = typeof turn.completedAt === "number" ? turn.completedAt : start;
    let reasoning = "";
    let opener: string | null = null;
    let latest: string | null = null;
    for (const item of turn.items as Item[]) {
      switch (item.type) {
        case "userMessage": {
          const text = userInputText(item.content);
          if (asked) asked.content = "null";
          asked = null;
          latest = text;
          if (opener === null) {
            opener = text;
            messages.push({ role: "user", text, timestamp: start });
          } else {
            messages.push({ role: "user", text, timestamp: start, display_kind: "steer" });
          }
          break;
        }
        case "agentMessage": {
          const questions = asyncQuestions(item);
          if (questions.length > 0) {
            const args = askedRowArgs(questions);
            asked = { role: "tool", name: "clarify", args, content: JSON.stringify({ responses: [], unanswered: true }), tool_call_id: item.id, timestamp: end };
            messages.push(asked);
            break;
          }
          const text = typeof item.text === "string" ? item.text : "";
          if (text.trim() === "" && reasoning.trim() === "") break;
          const message: StoredMessage = { role: "assistant", text, timestamp: end };
          if (reasoning.trim() !== "") message.reasoning = reasoning;
          messages.push(message);
          reasoning = "";
          break;
        }
        case "reasoning": {
          const summary = Array.isArray(item.summary) ? item.summary.filter((part: unknown) => typeof part === "string" && part !== "").join("\n\n") : "";
          if (summary) reasoning = reasoning ? `${reasoning}\n\n${summary}` : summary;
          break;
        }
        case "contextCompaction": {
          const asked = !(turn.items as Item[]).some((other) => other.type === "userMessage");
          if (asked && opener === null) {
            opener = `/${compactCommand}`;
            messages.push({ role: "user", text: opener, timestamp: start });
          }
          messages.push({ role: "compaction", trigger: asked ? "manual" : "auto", timestamp: end });
          break;
        }
        default: {
          agents.item(item);
          const tool = gatewayTool(item, agents.calledAbout(item, nicknames));
          if (!tool) break;
          const message: StoredMessage = {
            role: "tool",
            name: tool.name,
            args: tool.args,
            content: JSON.stringify(gatewayResult(item, cwd)),
            tool_call_id: item.id,
            timestamp: end,
          };
          if (tool.context) message.context = tool.context;
          messages.push(message);
        }
      }
    }
    if (last && turn.status === "inProgress" && turn.items.length === 0) {
      opener = `/${compactCommand}`;
      messages.push({ role: "user", text: opener, timestamp: start });
    }
    if (reasoning.trim() !== "") messages.push({ role: "assistant", text: "", timestamp: end, reasoning });
    if (last && turn.status === "inProgress" && active && opener !== null) {
      running = { turnId: turn.id, user: latest ?? opener, items: turn.items as Item[] };
      ends.set(turn.id, messages.length);
      return;
    }
    if (turn.status === "failed") {
      const error = turn.error?.message ? turn.error.message : "Codex stopped with an error.";
      messages.push({ role: "assistant", text: error, timestamp: end, display_kind: "failed_turn" });
    } else if (turn.status === "interrupted" || turn.status === "inProgress") {
      const previous = messages.at(-1);
      if (previous?.role === "assistant" && previous.display_kind === undefined) previous.display_metadata = { interrupted: true };
      else messages.push({ role: "assistant", text: "", timestamp: end, display_metadata: { interrupted: true } });
    }
    // How long it took, as Codex keeps it, with its last message (feature turn_usage).
    // Codex keeps no tokens with a turn: those the bridge heard are kept by the bridge.
    const closing = messages.at(-1);
    if (messages.length > from && closing && typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs) && turn.durationMs >= 0) {
      closing.turn_usage = { ...closing.turn_usage, seconds: turn.durationMs / 1000 };
    }
    ends.set(turn.id, messages.length);
  });
  return { messages, running, ends };
}

/**
 * The sub-agents a stored thread's calls about them (other than a spawn) may name: those
 * its items tell of, in the order they appear, when it has such a call; none otherwise.
 * Their nicknames are in their own threads.
 */
export function subagentsCalledIn(thread: Pick<Thread, "turns">): string[] {
  const items = ((thread.turns ?? []) as Turn[]).flatMap((turn) => (Array.isArray(turn.items) ? (turn.items as Item[]) : []));
  if (!items.some((item) => item.type === "collabAgentToolCall" && item.tool !== "spawnAgent")) return [];
  const ids = new Set<string>();
  for (const item of items) {
    if (item.type === "subAgentActivity" && typeof item.agentThreadId === "string") ids.add(item.agentThreadId);
    if (item.type !== "collabAgentToolCall") continue;
    for (const id of [...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []), ...Object.keys(item.agentsStates ?? {})]) if (typeof id === "string") ids.add(id);
  }
  return [...ids];
}
