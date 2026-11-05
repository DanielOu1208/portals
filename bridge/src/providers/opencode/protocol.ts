// The parts of OpenCode 2's HTTP API (https://opencode.ai/v2/docs/api) the bridge reads,
// as the server sends them (OpenCode 2.2.5). Only the fields read are named; the rest
// pass through unread.

import type { SessionTextDelta, SessionTextEnded, SessionTextStarted, SessionReasoningDelta, SessionReasoningEnded, SessionReasoningStarted, PromptFileAttachment } from "@opencode/client";

export type Json = Record<string, unknown>;

export interface ModelRef {
  id: string;
  providerID: string;
  /** A thinking level such as `low` or `high`; `default` when none was chosen. */
  variant?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface SessionInfo {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  model?: ModelRef;
  tokens?: TokenUsage;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { created: number; updated: number; busy?: number; idle?: number; archived?: number };
  location?: { directory: string };
}

export interface ModelInfo {
  id: string;
  providerID: string;
  name: string;
  enabled?: boolean;
  capabilities?: { tools?: boolean; input?: string[] };
  variants?: { id: string }[];
  limit?: { context?: number };
}

export interface StructuredError {
  type: string;
  message: string;
  status?: number;
}

/** A skill OpenCode would use in a folder (`GET /api/skill`): the user's, a plugin's, or one it comes with. */
export interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  path?: string;
  /** OpenCode may reach for it by itself, without the name being written. */
  autoinvoke?: boolean;
}

export interface ToolContent {
  type: "text" | "file";
  text?: string;
  uri?: string;
  name?: string | null;
}

export type ToolState =
  | { status: "streaming"; input: string }
  | { status: "running"; input: Json; metadata?: Json }
  | { status: "completed"; input: Json; content: ToolContent[]; metadata?: Json }
  | { status: "error"; input: Json; error: StructuredError; content?: ToolContent[]; metadata?: Json };

export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; state: ToolState };

export type Message =
  | { type: "user"; id: string; text: string; files?: PromptFileAttachment[]; time: { created: number } }
  | { type: "synthetic"; id: string; text: string; description?: string; metadata?: Json; time: { created: number } }
  | { type: "assistant"; id: string; content: AssistantContent[]; time: { created: number; completed?: number }; error?: StructuredError; tokens?: TokenUsage }
  | { type: "compaction"; id: string; status: "running" | "completed" | "failed"; reason: "auto" | "manual"; time: { created: number } }
  | { type: "idle"; id: string; outcome: "succeeded" | "failed" | "interrupted"; error?: StructuredError; time: { created: number } }
  | { type: string; id: string; time: { created: number } };

export interface PermissionRequest {
  id: string;
  sessionID: string;
  /** `shell`, `edit`, `read`, `webfetch`, … */
  action: string;
  /** What it acts on: the command, the files, the URL. */
  resources: string[];
  /** The patterns "always" saves as the project's rules. */
  save?: string[];
  metadata?: Json;
  /** The tool call that asks. */
  source?: { type: string; messageID: string; id: string };
}

export type PermissionDecision = "once" | "always" | "reject";

/** One event from `GET /api/event`: `data.sessionID` names the session, where there is one. */
export interface OpenCodeEvent {
  id: string;
  created?: number;
  type: string;
  data: Json & { sessionID?: string };
}

/** The pinned native discriminants keep piece identity identical for deltas and snapshots. */
export function textPiece(event: OpenCodeEvent): { key: string; kind: "text" | "reasoning"; phase: "started" | "delta" | "ended"; text: string } | undefined {
  if (!/^session\.(text|reasoning)\.(started|delta|ended)$/.test(event.type)) return;
  if (typeof event.data.assistantMessageID !== "string" || typeof event.data.ordinal !== "number") return;
  const native = event as unknown as SessionTextDelta | SessionTextEnded | SessionTextStarted | SessionReasoningDelta | SessionReasoningEnded | SessionReasoningStarted;
  const kind = native.type.startsWith("session.text.") ? "text" : "reasoning";
  const key = `${native.data.assistantMessageID}:${kind}:${native.data.ordinal}`;
  if (native.type === "session.text.delta" || native.type === "session.reasoning.delta") return { key, kind, phase: "delta", text: native.data.delta };
  if (native.type === "session.text.ended" || native.type === "session.reasoning.ended") return { key, kind, phase: "ended", text: native.data.text };
  return { key, kind, phase: "started", text: "" };
}

/** Reject partial or malformed counts rather than publishing NaN to the app. */
export function tokenTotal(tokens: TokenUsage | null | undefined): number | undefined {
  if (!tokens) return;
  const counts = [tokens.input, tokens.output, tokens.reasoning ?? 0, tokens.cache?.read, tokens.cache?.write];
  if (!counts.every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0)) return;
  return counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
}
