import { basename } from "node:path";
import type { StoredMessage } from "../types.ts";
import { TurnTokens } from "../spent.ts";
import { tokenTotal } from "./protocol.ts";
import { notSignedIn } from "../signIn.ts";
import type { Json, Message } from "./protocol.ts";
import { gatewayResult, gatewayTool, type ToolOutcome } from "./tools.ts";

// An OpenCode conversation as `session.resume` returns it (docs/gateway-protocol.md,
// section 8), from OpenCode's own messages (`GET /api/session/{id}/message`). Each of
// the agent's steps is a message of its own, holding its reasoning, its text and its
// tool calls in order; an `idle` message ends each turn and says how it went.

const seconds = (ms: number) => ms / 1000;

export function storedMessages(messages: readonly Message[], cwd: string): StoredMessage[] {
  const stored: StoredMessage[] = [];
  const spent = new TurnTokens();
  const counted = new Set<string>();
  for (const message of messages) {
    const at = seconds(message.time?.created ?? 0);
    switch (message.type) {
      case "user": {
        const user = message as Extract<Message, { type: "user" }>;
        const images = (user.files ?? []).filter((file) => file.mime.startsWith("image/"));
        const markers = images.map((file, index) => `@image:${file.name ? basename(file.name).replace(/[\r\n]/g, " ") : `image-${index + 1}.${imageExtension(file.mime)}`}`);
        if (typeof user.text === "string") stored.push({ role: "user", text: [user.text, ...markers].filter((text) => text !== "").join("\n"), timestamp: at });
        break;
      }
      case "assistant": {
        if (!counted.has(message.id)) {
          spent.add(tokenTotal((message as Extract<Message, { type: "assistant" }>).tokens));
          counted.add(message.id);
        }
        let reply = "";
        let reasoning = "";
        const flush = () => {
          if (reply !== "" || reasoning !== "") stored.push({ role: "assistant", text: reply, timestamp: at, ...(reasoning ? { reasoning } : {}) });
          reply = "";
          reasoning = "";
        };
        for (const part of (message as Extract<Message, { type: "assistant" }>).content ?? []) {
          if (part.type === "text") reply += part.text;
          else if (part.type === "reasoning") reasoning += reasoning === "" ? part.text : `\n\n${part.text}`;
          else if (part.type === "tool") {
            flush();
            const input: Json = typeof part.state.input === "object" && part.state.input !== null ? part.state.input : {};
            const tool = gatewayTool(part.name, input);
            const outcome: ToolOutcome =
              part.state.status === "completed"
                ? { ok: true, content: part.state.content, metadata: part.state.metadata }
                : part.state.status === "error"
                  ? { ok: false, error: part.state.error, content: part.state.content, metadata: part.state.metadata }
                  : { ok: "stopped" };
            const result = gatewayResult(part.name, input, tool, outcome, cwd);
            stored.push({
              role: "tool",
              name: tool.name,
              args: tool.args,
              ...(tool.context ? { context: tool.context } : {}),
              content: JSON.stringify(result),
              tool_call_id: part.id,
              timestamp: at,
            });
          }
        }
        flush();
        break;
      }
      case "compaction": {
        const compaction = message as Extract<Message, { type: "compaction" }>;
        if (compaction.status === "completed") stored.push({ role: "compaction", trigger: compaction.reason === "manual" ? "manual" : "auto", timestamp: at });
        break;
      }
      case "idle": {
        const idle = message as Extract<Message, { type: "idle" }>;
        if (idle.outcome === "failed") {
          stored.push({ role: "assistant", text: idle.error?.type === "provider.authentication" || idle.error?.status === 401 ? notSignedIn("opencode") : idle.error?.message || "OpenCode stopped with an error.", timestamp: at, display_kind: "failed_turn" });
        }
        spent.close(stored);
        break;
      }
      default:
        // Model and agent switches, shell commands, system notes: not shown (yet).
        break;
    }
  }
  return stored;
}

function imageExtension(mime: string): string {
  switch (mime) {
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return "jpg";
  }
}
