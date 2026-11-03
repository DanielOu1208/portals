// Pi's RPC mode on the wire: the commands the bridge writes, and the answers, events and
// dialogs Pi prints, one JSON value per line (Pi's docs/rpc.md, rpc-commands.md, json.md,
// rpc-extension-ui.md, message-types.md and session-format.md, release 1.1.0).
//
// Typed loosely on purpose. Pi changed these shapes in several releases in a row, so
// every field is optional, the code that reads a record checks what it uses, and a
// record whose `type` nothing here names is no error.

// MARK: Messages

/** One block of a message's content: text, an image, thinking or a tool call. */
export interface PiBlock {
  type?: string;
  text?: string;
  thinking?: string;
  /** An image: base64. */
  data?: string;
  mimeType?: string;
  /** A tool call. Its id holds a `|` (`call_…|fc_…`). */
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

/**
 * A message as events, `get_messages` and the session file carry it. `role` is
 * `system`, `user`, `assistant`, `toolResult`, or one of the coding agent's own:
 * `custom` (an extension's), `bashExecution`, `branchSummary`, `compactionSummary`.
 */
export interface PiMessage {
  role?: string;
  /** A string for older user messages, blocks otherwise. */
  content?: string | PiBlock[];
  /** Milliseconds since 1970. */
  timestamp?: number;
  /** An assistant message's: `pending` while it streams, then `stop`, `length`, `toolUse`, `error`, `aborted` or `deferred`. */
  /** An assistant message's tokens (pi-ai's `Usage`): `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`. */
  usage?: Record<string, unknown>;
  stopReason?: string;
  errorMessage?: string;
  /** An assistant message's: the model that wrote it, and that model's provider. */
  provider?: string;
  model?: string;
  /** A tool result's. */
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  /** How long the tool ran; absent when it did not run. */
  durationMs?: number;
  /** An extension's message: whether a terminal shows it. */
  display?: boolean;
  customType?: string;
}

/** What a tool returned (`tool_execution_end.result`). */
export interface PiToolResult {
  content?: PiBlock[];
  details?: unknown;
  /** `bash`: `{output, truncated, exit_code, wall_time_seconds}`; `read`: the text. */
  structuredContent?: unknown;
  isError?: boolean;
}

// MARK: What Pi prints

/** An answer to a command, matched by `id`. Pi's answer to a line it could not read has `command: "parse"` and no id. */
export interface PiResponse {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  data?: any;
  error?: string;
}

/**
 * Something an extension shows or asks. `select`, `confirm`, `input` and `editor` are
 * dialogs and wait for a `PiUiResponse`; `notify`, `setStatus`, `setWidget`, `setTitle`
 * and `set_editor_text` wait for nothing.
 */
export interface PiUiRequest {
  type: "extension_ui_request";
  id?: string;
  method?: string;
  title?: string;
  /** `confirm`'s second line, or what `notify` says. */
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** Milliseconds after which Pi settles a dialog itself, saying nothing. */
  timeout?: number;
  /** `info`, `warning` or `error`. */
  notifyType?: string;
}

/** The part of a `message_update` that says what changed: one block's start, a piece of it, or its end. */
export interface PiMessageDelta {
  /** `text_start`, `text_delta`, `text_end`, `thinking_*`, `toolcall_*`. */
  type?: string;
  contentIndex?: number;
  delta?: string;
  /** With `text_end` and `thinking_end`: the whole block. */
  content?: string;
}

/** A session event (json.md). Which fields are there goes by `type`. */
export interface PiEvent {
  type?: string;
  /** `message_start`, `message_end`, `turn_end`. */
  message?: PiMessage;
  assistantMessageEvent?: PiMessageDelta;
  /** `tool_execution_*`. */
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: PiToolResult;
  isError?: boolean;
  durationMs?: number;
  /** On the calls a `codemode` script makes: the script's own call. */
  parentToolCallId?: string;
  /** `agent_settled`. */
  aborted?: boolean;
  /** `compaction_start`, `compaction_end`: `manual`, `threshold` or `overflow`. */
  reason?: string;
  errorMessage?: string;
  willRetry?: boolean;
  /** `auto_retry_start`. */
  attempt?: number;
  maxAttempts?: number;
  /** `session_info_changed`. */
  name?: string;
  /** `thinking_level_changed`. */
  level?: string;
  /** `extension_error`. */
  extensionPath?: string;
  event?: string;
  error?: string;
  /** What the bridge does not read (`agent_end`'s `messages`, a retry's `delayMs`), and whatever a later Pi adds. */
  [more: string]: unknown;
}

/** Any line Pi prints. */
export type PiRecord = PiResponse | PiUiRequest | PiEvent;

/** A compaction's result, in `compaction_end` and in `compact`'s answer. */
export interface PiCompaction {
  summary?: string;
  tokensBefore?: number;
  /** Pi's guess at the context's size afterwards. */
  estimatedTokensAfter?: number;
}

// MARK: Answers

/** A model as `get_state` and `get_available_models` give it. */
export interface PiModel {
  id?: string;
  name?: string;
  provider?: string;
  /** Whether it thinks at all. */
  reasoning?: boolean;
  /** What it takes: `text`, `image`. */
  input?: string[];
  contextWindow?: number;
  /** Pi's levels as the model's own words; null for a level it does not have. */
  thinkingLevelMap?: Record<string, string | null>;
}

/** `get_state`. */
export interface PiState {
  model?: PiModel;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  /** Named before the file exists: Pi writes it at the first message. */
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
}

/** `get_session_stats`. Right after a compaction `contextUsage.tokens` is null. */
export interface PiSessionStats {
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}

/** One of `get_commands`: an extension's command, a prompt template or a skill. */
export interface PiCommandInfo {
  name?: string;
  description?: string;
  /** `extension`, `prompt` or `skill`. */
  source?: string;
}

// MARK: What the bridge writes

export interface PiImage {
  type: "image";
  /** Base64. */
  data: string;
  mimeType: string;
}

/** A command. The client adds its `id`. */
export type PiCommand =
  | { type: "prompt"; message: string; images?: PiImage[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "abort" | "clear_queue" | "get_state" | "get_available_models" | "get_commands" | "get_session_stats" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "set_session_name"; name: string }
  | { type: "compact"; customInstructions?: string };

/** The answer to a dialog. Not a command: Pi sends no `response` for it. */
export type PiUiResponse = { type: "extension_ui_response"; id: string } & ({ value: string } | { confirmed: boolean } | { cancelled: true });

// MARK: The session file

/**
 * One line of a session file (session-format.md). The first is the header (`session`:
 * the session's `id` and the folder it runs in); the rest are a tree by `id` and
 * `parentId`.
 */
export interface PiEntry {
  /** `session`, `message`, `compaction`, `session_info`, `model_change`, `thinking_level_change`, `custom_message`, … */
  type?: string;
  id?: string;
  parentId?: string | null;
  /** ISO 8601. */
  timestamp?: string;
  message?: PiMessage;
  /** The header's: the folder the session runs in. */
  cwd?: string;
  /** A `compaction`'s. */
  tokensBefore?: number;
  /** A `session_info`'s. */
  name?: string;
  /** A `model_change`'s. */
  provider?: string;
  modelId?: string;
  /** A `thinking_level_change`'s, in Pi's word. */
  thinkingLevel?: string;
}
