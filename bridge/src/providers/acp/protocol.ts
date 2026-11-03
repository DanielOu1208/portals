// The parts of the Agent Client Protocol, version 1, that the bridge reads and writes
// (agentclientprotocol.com/protocol/v1): JSON-RPC 2.0, one message per line, on the
// agent's standard input and output. Written out by hand, as far as the bridge goes:
// the protocol's own package is 14 MB with its dependency, for types alone.
//
// Agents differ in what they send, so everything an agent may leave out is optional
// here and checked where it is read.

export const protocolVersion = 1;

export type RpcId = string | number;

/** `authenticate` is needed first: the agent is not signed in. */
export const authRequiredCode = -32000;
export const methodNotFoundCode = -32601;

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

export interface AgentCapabilities {
  /** `session/load`: a session can be taken up again, with its conversation sent once more. */
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean };
  sessionCapabilities?: {
    /** `session/resume`: the same without the conversation. */
    resume?: object | null;
  };
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: { name?: string; title?: string | null; version?: string };
  authMethods?: AuthMethod[];
}

export interface ConfigChoice {
  value: string;
  name: string;
  description?: string | null;
}

export interface ConfigGroup {
  group: string;
  name: string;
  options: ConfigChoice[];
}

/** Something a session can be set to: its model, its mode, its thinking level. */
export interface ConfigOption {
  id: string;
  name: string;
  /** `model`, `mode`, `thought_level`, or something of the agent's own. */
  category?: string | null;
  /** `select` is the only kind the bridge sets. */
  type?: string;
  currentValue?: unknown;
  options?: (ConfigChoice | ConfigGroup)[];
}

/** One way a session can work (`session/set_mode`): Cursor's `agent`, `plan` and `ask`. */
export interface SessionMode {
  id: string;
  name?: string;
  description?: string | null;
}

/** The modes a session has and the one it is in, from agents that have modes. */
export interface SessionModes {
  currentModeId?: string;
  availableModes?: SessionMode[];
}

/** What `session/new`, `session/load`, `session/resume` and `session/set_config_option` answer with, as far as it is read. */
export interface SessionState {
  sessionId?: string;
  configOptions?: ConfigOption[] | null;
  modes?: SessionModes | null;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

export type ToolCallContent =
  | { type: "content"; content?: ContentBlock }
  | { type: "diff"; path?: string; oldText?: string | null; newText?: string }
  | { type: string; [key: string]: unknown };

/** A tool call, whole (`tool_call`) or as the fields that changed (`tool_call_update`). */
export interface ToolCallFields {
  toolCallId: string;
  title?: string | null;
  /** The tool's own name, from agents that give it. */
  name?: string | null;
  /** `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`. */
  kind?: string | null;
  /** `pending`, `in_progress`, `completed`, `failed`. */
  status?: string | null;
  content?: ToolCallContent[] | null;
  locations?: { path?: string }[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanEntry {
  content?: string;
  /** `pending`, `in_progress`, `completed`. */
  status?: string;
}

export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
}

/** What `session/update` carries, by `sessionUpdate`. Kinds the bridge does not read are left out. */
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"; content?: ContentBlock; messageId?: string | null }
  | ({ sessionUpdate: "tool_call" | "tool_call_update" } & ToolCallFields)
  | { sessionUpdate: "plan"; entries?: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands?: AvailableCommand[] }
  | { sessionUpdate: "config_option_update"; configOptions?: ConfigOption[] }
  /** The session is in another mode now: after `session/set_mode`, or by the agent's own doing. */
  | { sessionUpdate: "current_mode_update"; currentModeId?: string }
  | { sessionUpdate: "session_info_update"; title?: string | null }
  | { sessionUpdate: "usage_update"; used?: number; size?: number }
  /**
   * Cursor's, to a client that takes its subagent sessions (cursor/subagents.ts): a
   * subagent started in this session, with its own session's id, and its end.
   */
  | { sessionUpdate: "subagent_spawned"; subagentSessionId?: string; name?: string; task?: string; _meta?: unknown }
  | { sessionUpdate: "subagent_state_update"; subagentSessionId?: string; state?: string; _meta?: unknown };

export interface PermissionOption {
  optionId: string;
  name?: string;
  /** `allow_once`, `allow_always`, `reject_once`, `reject_always`. */
  kind?: string;
}

/** `session/request_permission`: the agent asks before a tool call. */
export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCallFields;
  options?: PermissionOption[];
}

/** The answer to it: one of the options, or `cancelled` when the turn was stopped first. */
export type PermissionOutcome = { outcome: { outcome: "selected"; optionId: string } } | { outcome: { outcome: "cancelled" } };

/** Why a turn ended, in the answer to `session/prompt`. */
export interface PromptResult {
  /** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`. */
  stopReason?: string;
  /** What the prompt's turn spent, from an agent that says (ACP's `usage`): `totalTokens`, all kinds together. */
  usage?: { totalTokens?: number };
}

/** The tokens a prompt's answer says its turn spent; 0 when it says none. */
export function promptTokens(result: PromptResult | null | undefined): number {
  const total = result?.usage?.totalTokens;
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
}
