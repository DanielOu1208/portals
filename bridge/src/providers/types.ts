// What an agent provider (the scripted fake, Claude Code, Codex) gives the
// bridge. Providers speak in neutral events; `sessions/session.ts` turns them into the
// Hermes-shaped events the app reads, keeps the replay log, and routes questions to the
// phone. A provider never sees a connection.

import type { RecentFolder } from "../folders.ts";
import type { TurnDiff } from "../sessions/turnDiff.ts";
import type { MentionLimit } from "../sessions/mentions.ts";
import type { From } from "../fleet/line.ts";
import type { SearchFile } from "../search/readers.ts";

/** An agent as the app's sidebar lists it (`profiles.list`). */
export interface AgentProfile {
  /** The `profile` the app sends back on every call. */
  name: string;
  /**
   * Which agent runs it: `claude`, `codex`, `pi`, `cursor`, `droid`, `fake`, or `hermes`
   * for a Hermes profile. The app goes by this, not by the name, for whose logo an agent
   * wears: a Hermes profile can be called anything, `pi` or `cursor` too.
   */
  kind: string;
  displayName: string;
  description: string;
  /** The model a new thread runs on when the app names none. */
  model: string;
  provider: string;
}

/** Thinking levels the app knows (AgentCore/ModelSetting.swift). */
export const thinkingLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** The levels the app knows, of those given, each once and weakest first. */
export function knownLevels(levels: readonly string[]): string[] {
  return thinkingLevels.filter((level) => levels.includes(level));
}

/**
 * Provider-specific permission and planning modes, set with `/mode`.
 * `medium` is offered only by providers that describe it in modeOptions.
 * `default` inherits the agent's own settings.
 */
export const threadModes = ["ask", "edits", "medium", "plan", "full", "default"] as const;
export type ThreadMode = (typeof threadModes)[number];

export interface ModeOption {
  id: ThreadMode;
  label: string;
  description: string;
}

export function isThreadMode(value: unknown): value is ThreadMode {
  return (threadModes as readonly unknown[]).includes(value);
}

export interface ModelCatalog {
  providers: { slug: string; name: string; models: string[] }[];
  /** The agent's own default. */
  model: string;
  provider: string;
  /** The agent's default thinking level, one of `thinkingLevels`. */
  reasoning: string;
  /**
   * The thinking levels each model takes, as `thinkingLevels` names, weakest first
   * (`model_levels`). A model left out takes any.
   */
  levels?: Record<string, string[]>;
  /**
   * The level each model runs at when a thread chooses none, as `thinkingLevels` names
   * (`model_default_levels`): Claude Code's differs by model. A model left out runs at
   * `reasoning`.
   */
  defaultLevels?: Record<string, string>;
  /**
   * What to call each model, for agents whose ids are not names (Claude Code's
   * `default` and `opus` are both "Opus 5.5"): `model_names`. A model left out goes by
   * its id. Models the list leaves out but a thread can still be on are named too, and
   * can still be chosen.
   */
  names?: Record<string, string>;
}

/** What a session runs on. Changed per session only, never as the agent's default. */
export interface SessionSettings {
  model: string;
  provider: string;
  /** A thinking level, or "" to leave it to the model. */
  reasoningEffort: string;
}

export interface ImageInput {
  filename: string;
  data: Buffer;
}

export interface Prompt {
  /** As the agent is sent it: with the paths of any attached files after it (`sessions/files.ts`). */
  text: string;
  images: ImageInput[];
  /** The paths of the files attached, named in `text`. */
  files?: string[];
  /** The files and folders mentioned (feature file_mentions), relative to the thread's folder, each in `text` as `@path` (sessions/mentions.ts). */
  mentions?: string[];
}

export type QueuePlacement = "steer" | "queue";

/**
 * What one of the agent's turns spent (feature `turn_usage`): how long it ran, and the
 * tokens it took in and gave out, cached ones too, each counted once (Claude's input
 * leaves out the cache's reads and writes, which are added; Codex's input has its cached
 * input in it already). The thread's own agent's, not its subagents': each of those says
 * its own. `tokens` only where the agent tells them; `seconds` where the bridge or the
 * agent timed the turn.
 */
export interface TurnUsage {
  seconds?: number;
  tokens?: number;
}

/**
 * One message of a stored conversation, in the shape `session.resume` returns
 * (docs/gateway-protocol.md, section 8). The last message of an ended turn may carry what
 * the turn spent (`turn_usage`, feature `turn_usage`), and what it changed (`turn_diff`,
 * feature `turn_diff`, which the bridge works out: sessions/turnDiff.ts).
 */
export type StoredMessage = StoredMessageBody & { turn_usage?: TurnUsage; turn_diff?: TurnDiff };

type StoredMessageBody =
  | {
      role: "user";
      text: string;
      timestamp: number;
      /** For messages in the user's place that the user did not write, such as `steer`. */
      display_kind?: string;
      display_metadata?: Record<string, unknown>;
      /** The id the device gave the message (`prompt.submit` `message_id`, feature `message_ids`): kept only while the bridge runs. */
      message_id?: string;
      /** Who sent it through the fleet (feature `senders`), read from its first line when it goes out: never stored. */
      from?: From;
      /**
       * The answers to questions asked without waiting, given on their card (feature
       * async_questions): the id of their `clarify` row, which shows them, so the app shows
       * no message of its own for it (sessions/answers.ts).
       */
      card_answer?: string;
    }
  | {
      role: "assistant";
      text: string;
      timestamp: number;
      reasoning?: string;
      /** `failed_turn`: the turn failed and `text` says why. */
      display_kind?: "failed_turn";
      display_metadata?: { interrupted?: boolean; failed_request_id?: string };
    }
  | {
      role: "tool";
      /** One of the gateway's tool names (`terminal`, `patch`, `read_file`, …); see section 9. */
      name: string;
      args: Record<string, unknown>;
      context?: string;
      /** The result as JSON text (plain text stays text). */
      content?: string;
      tool_call_id: string;
      timestamp: number;
      /** `tool_result_metadata.inline_diff`: the event's `inlineDiff`. */
      display_metadata?: { tool_result_metadata?: { inline_diff?: string } };
    }
  | {
      /** The conversation so far was summarised to free the context (feature `compaction`). */
      role: "compaction";
      /** `manual`: asked for with `/compact`; `auto`: the agent did it as the context filled up. */
      trigger: CompactionTrigger;
      /** Tokens in the context before, when the agent said. */
      tokens_before?: number;
      timestamp: number;
    };

/** Why a conversation was compacted: `/compact`, or the agent by itself as the context filled up. */
export type CompactionTrigger = "manual" | "auto";

/** Usage of the model's context window. */
export interface ContextUsage {
  used: number;
  max: number;
  estimated?: boolean;
}

/**
 * What happens in a session, as the provider reports it. Tool names and args are
 * already the gateway's (`terminal {command}`, `patch {path, old_string, new_string}`),
 * so the app styles them; mapping an agent's own tools onto them is the provider's job.
 */
export type ProviderEvent =
  /** Invalidate live MCP sign-in cards; no authentication data is carried by an event. */
  | { type: "mcp.auth" }
  | { type: "queue.consumed"; requestId: string }
  | { type: "queue.failed"; requestId: string; error: string }
  /** Droid's receipt for a message whose earlier delivery could not be confirmed. */
  | { type: "queue.taken"; requestId: string; prompt: Prompt }
  /** A piece of the reply. */
  | { type: "text"; text: string }
  /** A closed piece of text written beside tool calls. `alreadyStreamed` when it also came as `text`. */
  | { type: "commentary"; text: string; alreadyStreamed: boolean }
  | { type: "reasoning"; text: string }
  /** Replaces only the current, uncommitted assistant segment after an SDK retry. */
  | { type: "assistant.replace"; text: string; reasoning: string }
  /** A passing status line ("Waiting for the model…"); "" clears it. */
  | { type: "status"; text: string }
  /**
   * What the agent says it is working on, in a few words, until it says something newer
   * or says something to the person (feature status_headline): Claude Code's summary of a
   * run of its tool calls, `toolIds` the calls it covers.
   */
  | { type: "headline"; text: string; toolIds: string[] }
  | { type: "working"; state: string; text: string }
  /** Something worth keeping in the thread. */
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "tool.start"; id: string; name: string; args: Record<string, unknown>; context?: string }
  | { type: "tool.progress"; id: string; output?: string; progress?: string; outputTruncated?: boolean }
  | { type: "turn.usage"; usage: TurnUsage }
  | {
      type: "tool.end";
      id: string;
      name: string;
      args: Record<string, unknown>;
      context?: string;
      /** Tool specific: `{output, exit_code}`, `{success, diff}`, `{status:"blocked", user_summary}`, … */
      result: unknown;
      durationSeconds?: number;
      /** A diff as Hermes prints it in a terminal (ANSI colours, `a/x → b/x`), for a result that has none of its own. */
      inlineDiff?: string;
      /**
       * The result's `diff` is the agent's exact record of the edit, which its history
       * will not give back as it is (Claude Code's structured patch): the bridge keeps it
       * under `id` and puts it in place of the rebuilt one when the thread is loaded
       * again (src/sessions/keptDiffs.ts).
       */
      keepDiff?: true;
    }
  | { type: "title"; title: string }
  | { type: "usage"; usage: ContextUsage }
  /** The conversation so far was summarised to free the context. `tokensBefore` only when the agent said. */
  | { type: "compacted"; trigger: CompactionTrigger; tokensBefore?: number }
  /**
   * The agent's stored copy of the conversation may have gone on in another of its apps
   * (a Hermes profile's Bot Chat, said to in Hermes Desktop or a terminal): the bridge asks
   * `changedConversation` once the thread is at rest.
   */
  | { type: "conversation.changed" }
  /** The agent itself failed (its process died, say), apart from any one turn. */
  | { type: "error"; message: string }
  /**
   * Questions the agent put to the person without waiting for them (Codex's
   * `request_user_input_async`): it goes on, and the person's next message answers them.
   * `id` is the agent's for them. `text` is them in words, as the agent wrote them in its
   * reply: what is shown in their place where no device that keeps a question past its
   * turn follows the thread (feature async_questions).
   */
  | { type: "questions"; id: string; questions: ClarifyQuestion[]; text: string }
  /** The thread's mode changed on the agent's side (a plan was approved, a rule was granted for the session). */
  | { type: "mode"; mode: ThreadMode }
  /** News of a subagent or a workflow the agent started: all that is known of it now. */
  | { type: "subagent"; subagent: SubagentInfo }
  /**
   * A turn the app did not start: one begun at the desk on a thread the bridge follows,
   * or one the agent began by itself. `user` is the message that opened it; `host`, for
   * the agent's own, says why in its place. It ends with `turn.end` like any other.
   * `clears`: for a turn told late (a Codex turn begun at the desk while the bridge,
   * back on its connection to Codex, caught up with the thread, or while it was down),
   * the subagents its message may take off the line (feature subagents_clear), each in
   * the run it had ended in: those that had ended when the bridge heard it, none when it
   * never heard it (it came before what the bridge heard meanwhile). Without it, all that
   * have ended. `command`: whether `user` is a command the agent ran (a `/compact`), not a
   * message it was given, from an agent that knows (Codex: a turn with a message of the
   * person's in it is never a command, whatever its words); else read from its words.
   */
  | { type: "turn.begin"; user: string; host?: HostNote; clears?: readonly EndedSubagent[]; command?: boolean }
  /**
   * The message that opened the running turn, which the agent first took for another: a
   * Codex turn loaded before its message came (Codex runs hooks first) was taken for a
   * `/compact`. A device that opens the thread is shown this one from then on.
   */
  | { type: "turn.opener"; user: string }
  /**
   * Every turn ends with exactly one of these, whatever happened. `spent`: what the turn
   * spent, as far as the agent tells it (its tokens; its own time for it, where it keeps
   * one); the bridge times a turn that does not say. `agentTurn`: the agent's own id for
   * the turn, where it has them and its history keeps no tokens (Codex), under which the
   * bridge keeps them (src/sessions/spent.ts).
   */
  | { type: "turn.end"; status: "complete" | "interrupted" | "error"; error?: string; retryable?: boolean; usage?: ContextUsage; spent?: TurnUsage; agentTurn?: string };

/** A subagent that had ended, and the run it ended in where its agent names runs (a Codex sub-agent's turn). */
export interface EndedSubagent {
  id: string;
  run?: string;
}

/**
 * Why an agent began a turn by itself, as the app shows it: one line in place of the
 * user's message. `kind` is the `display_kind` the app knows such a line by
 * (`process_complete` for commands, `async_delegation_complete` for agents and
 * workflows); `hidden` shows none.
 */
export interface HostNote {
  kind: "process_complete" | "async_delegation_complete" | "hidden";
  text: string;
}

/**
 * An agent the thread's agent set to work on part of its task (a subagent), or a
 * workflow of such agents, as the subagents line shows it (feature `subagents`). It may
 * run on after the turn that started it, in the background.
 */
export interface SubagentInfo {
  /** The agent's id for it, by which it is stopped. */
  id: string;
  /** A command is a terminal command run in the background (feature background_commands). */
  kind: "agent" | "workflow" | "command";
  /** What it was asked to do, in a few words: a subagent's description, a workflow's. */
  goal: string;
  /** A workflow's name. */
  name?: string;
  /** What its agent calls it (a Codex sub-agent's nickname, "Darwin"). */
  nickname?: string;
  /** The kind of agent it is (a Codex sub-agent's role, "worker"; a Claude subagent's type, "Explore"). */
  role?: string;
  /** The subagent that started it, when one of these started it rather than the thread's agent: a subagent's own subagent. */
  parent?: string;
  /**
   * Which run of it this is, where its agent says (a Codex sub-agent's turn): one given
   * more to do after it ended starts a new one. The bridge's own; not sent to devices.
   */
  run?: string;
  status: SubagentStatus;
  /** Milliseconds since 1970. */
  startedAt: number;
  endedAt?: number;
  /** It runs on after the turn that started it. */
  background: boolean;
  /** It can be stopped by itself, apart from the turn (`ProviderSession.stopSubagent`). */
  stoppable: boolean;
  /** A line on what it is doing now. */
  summary?: string;
  /** The tool it used last, by the gateway's name (section 9). */
  tool?: string;
  /** What it answered, or why it failed, once it has ended. */
  result?: string;
  /** A command's output so far, its end only (`liveOutput.ts`), and whether its start was left out. */
  output?: string;
  outputTruncated?: boolean;
  model?: string;
  tokens?: number;
  toolUses?: number;
  /** A workflow's phases, in order. */
  phases?: { index: number; title: string }[];
  /** A workflow's agents, in the order they started. */
  agents?: WorkflowAgent[];
}

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

/** One agent of a workflow. */
export interface WorkflowAgent {
  id: string;
  label: string;
  /** The title of the phase it runs in. */
  phase?: string;
  model?: string;
  status: SubagentStatus;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  /** The start of what it answered. */
  result?: string;
}

export type ApprovalChoice = "once" | "session" | "always" | "deny";

export interface ClarifyQuestion {
  qid: string;
  question: string;
  choices: string[];
  multiSelect: boolean;
  /** A word or two the agent gives the question ("Auth method"), when it gives one. */
  header?: string;
  /** What each choice means, by choice, when the agent says. */
  descriptions?: Record<string, string>;
}

export interface ApprovalOption {
  id: string;
  label: string;
  description: string;
  effects: { scope: "once" | "session" | "settings" | "new_session" | "external"; text: string }[];
  requiresConfirmation?: boolean;
}

export interface ApprovalDetail {
  toolId: string;
  name: string;
  type: string;
  command?: string;
  path?: string;
  diff?: string;
  server?: string;
  tool?: string;
  impact?: string;
  violationType?: string;
  reason?: string;
  operation?: string;
  target?: string;
  findings?: { title: string; message: string; severity?: string }[];
}

/**
 * A question for the person on the phone. `subagent`: the subagent that asks it (its
 * id), which may run on after the turn: the turn's end does not take the question back,
 * nor does a Stop that leaves the subagent running.
 */
export type AgentRequest =
  | {
      kind: "approval";
      command: string;
      description?: string;
      choices: ApprovalChoice[];
      options?: ApprovalOption[];
      planContent?: string;
      details?: ApprovalDetail[];
      /** A plan to approve (Claude's ExitPlanMode): approving it starts the work in `startsIn`. */
      plan?: { startsIn: ThreadMode };
      /**
       * The agent is told what the user says with a no along with the no itself (Claude
       * Code's reason for a denial). Without it, the bridge hands what they said to the
       * thread as a message of theirs once the no has gone back (feature approval_notes).
       */
      takesNote?: boolean;
      subagent?: string;
    }
  | {
      kind: "clarify";
      questions: ClarifyQuestion[];
      requiresAllAnswers?: boolean;
      subagent?: string;
      /** Asked without waiting (a `questions` event): it stays open past the turn's end, and its answer goes to the agent as the person's message. */
      async?: true;
    };

/** How a question was settled. Declining an approval is `deny`; cancelling a question is `answers: null`. */
export type RequestAnswer =
  | { kind: "approval"; choice: ApprovalChoice; /** What the user said with a no ("keep planning: …"). */ note?: string }
  | { kind: "approval.option"; option: string; editedPlan?: string; note?: string }
  | { kind: "clarify"; answers: Record<string, string | null> | null }
  /** Nobody answered: the turn was interrupted or ended, or the provider withdrew it. */
  | { kind: "withdrawn"; reason: string };

/** How a provider reaches the bridge for one session. */
export interface SessionSink {
  emit(event: ProviderEvent): void;
  /**
   * Puts a question to the phones that follow the session and waits for the first
   * answer. Aborting `signal` withdraws it (the abort reason, when a string, is the
   * reason the app is given).
   */
  ask(request: AgentRequest, signal?: AbortSignal): Promise<RequestAnswer>;
}

export interface ModelChangeResult {
  /** The running turn keeps its model; the change applies from the next one. */
  deferred: boolean;
}

/**
 * A setting the agent cannot be given: a mode it has not, a model or a thinking level it
 * does not take. The message is a sentence for the user, and the gateway answers the
 * call with it as -32602, not as a failure of the bridge.
 */
export class SettingRefused extends Error {}

/** One conversation inside a provider. */
export interface ProviderSession {
  mcpAuth?(action: import("./mcpAuth.ts").McpAuthAction): Promise<{ servers: import("./mcpAuth.ts").McpAuthCard[] }>;
  /** The conversation so far, oldest first. Read once, when the session is loaded. */
  history(): Promise<StoredMessage[]>;
  /**
   * Called once, right after `history()`: the bridge's side is wired up and events
   * reported from now on are kept. Returns the turn already under way when the session
   * was loaded (one the bridge started before it restarted, or one started at the
   * desk), as the user message that opened it, which `history()` ends with; null when
   * nothing runs. Agents whose turns all start from the app need not have it.
   */
  attached?(): { user: string } | null;
  settings(): SessionSettings;
  /**
   * Stops one subagent or workflow the agent started (reported as `subagent`), leaving
   * the turn and the others running. False when there is none such running.
   */
  stopSubagent?(id: string): Promise<boolean>;
  /**
   * A subagent's own conversation (one reported as `subagent` of kind `agent`), oldest
   * first, in the shape of `history()`: what it was asked, where its agent keeps that,
   * its tool calls and what it said. Read each time it is asked for, so one still at work
   * gives what it has done so far. Agents that keep none need not have it.
   */
  subagentMessages?(id: string): Promise<StoredMessage[]>;
  /**
   * Read once, with `history()`: the subagents and workflows the stored conversation
   * tells of, all ended, each with the turn that started it: 0 for the conversation's
   * last turn, -1 for the one before it, and so on.
   */
  pastSubagents?(): { subagent: SubagentInfo; turn: number }[];
  /**
   * Read once, with `history()`: true when the stored conversation's last turn was cut
   * off mid-way (its agent's process stopped with the bridge, a crash) rather than ended,
   * as the agent's own record shows (Claude Code: its last entry is not the model's
   * finished answer). A turn the bridge recorded running that is over at the next load is
   * then told as stopped, not as finished. Agents whose record cannot tell need not have it.
   */
  lastTurnCutOff?(): boolean;
  /** Starts a turn. The provider reports it through the sink and ends it with `turn.end`. */
  startTurn(prompt: Prompt): void;
  /**
   * Adds a message to the running turn, for agents that can take one mid-turn. Without
   * it, messages wait for the turn to end. Resolves false when the agent did not take
   * it because the turn ended first: the bridge then answers it in a turn of its own.
   * `refused` when, beyond that, the agent surely never had it (it said no, or the
   * message never went to it); false leaves open that it reached the agent, whose own
   * record then may have it (an answer lost as its turn ended).
   */
  steer?(prompt: Prompt): Promise<boolean | "refused">;
  /** Durable queue handoff. False means nothing was sent; consumption is reported by request ID. */
  enqueue?(prompt: Prompt, requestId: string): Promise<boolean>;
  deleteQueued?(requestId: string): Promise<boolean>;
  /** A saved consumption receipt, read without starting the agent after a bridge restart. */
  queuedConsumed?(requestId: string): boolean;
  /** False while the running turn takes no message (Codex compacting): one sent then waits for it to end. True when absent. */
  steerable?(): boolean;
  /** Gives the thread a title of the user's, kept by the agent as its own name for it. */
  rename?(title: string): Promise<void>;
  /**
   * Stops the running turn, which still ends with `turn.end` (`interrupted`). False when
   * nothing was running. Also asked with no turn running while `steer` has not resolved
   * for a message handed to the turn before: true when the agent stops what comes of it.
   */
  interrupt(): Promise<boolean>;
  /**
   * True while the agent may be running a turn the bridge is not shown as running: one
   * the provider ended for the app (Codex's grace timer ends a turn Codex did not stop,
   * and Codex may go on with it until it says that turn completed), or one begun at the
   * desk that the provider has not reported yet. Such a thread is still at work (it is
   * not removed). False when absent; throws when the agent cannot be asked.
   */
  stopping?(): Promise<boolean>;
  /**
   * True while work the agent began in a turn runs on after the turn ended, in the
   * thread's own process (Claude Code's background commands and subagents), which ends
   * when the session closes. Such a thread is not removed. False when absent.
   */
  hasBackgroundWork?(): boolean;
  setModel(model: string, provider: string): Promise<ModelChangeResult>;
  setReasoning(level: string): Promise<void>;
  /** For agents with modes (`Provider.supportsModes`): how much the thread asks before acting. */
  mode?(): ModeState;
  setMode?(mode: ThreadMode): Promise<void>;
  /**
   * The thread was put back in `default` from another mode whose policy the agent may
   * still have for it, and the agent has not undone that yet (Codex sends what default
   * comes to with its next turn). The thread's record keeps that it has to until then.
   */
  modeResetPending?(): boolean;
  /**
   * While the agent's side is not back in step with the thread (after its connection
   * dropped, until the turns it missed are told): resolves once it is. A message sent at
   * rest meanwhile waits on the thread's list, so its turn comes after those turns.
   */
  catchingUp?(): Promise<void> | undefined;
  /**
   * Asked for the first message waiting at rest for `catchingUp`, which began to wait at
   * `since` (ms since the epoch): resolves with why the agent cannot be reached, once a
   * while after `since` (as long as a call waits for the agent; Codex's 15 seconds) the
   * bridge's connection to it is down, or when it drops after that while the catch-up
   * still runs; with undefined once the catch-up ends first, or `signal` is aborted. The
   * message then fails rather than wait on. Absent: such a message waits for the
   * catch-up however long it takes.
   */
  unreachable?(since: number, signal: AbortSignal): Promise<string | undefined>;
  /**
   * The agent's own id for the latest of the thread's turns the bridge has shown (null
   * before any): a message that fails now shows right after it, and goes back there when
   * the thread is loaded again (`turnEnd`). Absent for an agent without such ids.
   */
  latestTurn?(): string | null;
  /** In the conversation `history` gave: how many of its messages come up to the end of turn `id`; undefined when that turn is not in it. */
  turnEnd?(id: string): number | undefined;
  /** The conversation as the agent has it now, for a thread only read (it may go on in a terminal). */
  reload?(): Promise<StoredMessage[]>;
  /**
   * For a thread continued here: whether the agent's own copy of the conversation was
   * written elsewhere since it was read (a Pi at the desk went on with it), so the thread
   * does not show what was said there. False while anything is in hand.
   */
  changedElsewhere?(): Promise<boolean>;
  /**
   * For an agent's one ongoing conversation, which its other apps write to as well (a
   * Hermes profile's Bot Chat): at rest, the conversation as the agent has it now when it
   * went on elsewhere since the bridge last read it, else null. The bridge takes the
   * messages in place, and every device that holds the thread takes them again; it calls
   * `take` once it has, so that a look it turns down (the thread no longer at rest) is
   * looked at again with the next change.
   */
  changedConversation?(): Promise<{ messages: StoredMessage[]; take(): void } | null>;
  close(): Promise<void>;
}

export interface ModeState {
  mode: ThreadMode;
  options?: ModeOption[];
  /** What `default` comes to under the agent's own settings, when known. */
  defaultsTo?: Exclude<ThreadMode, "default">;
}

export interface SessionOptions {
  /** The thread id, chosen by the bridge for a new session. */
  id: string;
  cwd: string;
  settings: SessionSettings;
  /** The thread's title, when it has one. */
  title?: string | null;
  mode?: ThreadMode;
  /** For a thread in plan mode: the mode it was in before, which an approved plan goes back to. */
  modeBeforePlan?: ThreadMode;
  /**
   * The thread was put back in `default` from another mode before its last turn began
   * (in an earlier run of the bridge, say): what the agent keeps of the other mode's
   * policy is to be undone with the next turn.
   */
  modeReset?: boolean;
  /** A session started at the desk (`session.adopt`): it may be open in a terminal too. */
  desk?: boolean;
  /** Only for reading (`session.adopt` mode `read`): nothing is sent to the agent, and the session is not joined. */
  readOnly?: boolean;
  /** The agent's one ongoing conversation (`Provider.ongoingThread`): `/new` in it compacts, and it keeps its name. */
  ongoing?: boolean;
}

/** Where an agent keeps its one ongoing conversation (`Provider.ongoingThread`). */
export interface OngoingThread {
  id: string;
  cwd: string;
  /** Unix seconds, when the agent says. */
  createdAt?: number;
  preview?: string;
}

/**
 * A session started outside the bridge, in a terminal at the desk, as `desk.list`
 * lists it (docs/gateway-protocol.md, section 11).
 *
 * `state`: Claude Code's are `open` (a terminal has it) or `closed`; Codex's are
 * `running`, `waiting` (on an approval or a question), `idle` (loaded, nothing running)
 * or `closed` (not loaded); Pi's are `open` (a Pi runs in a terminal in the session's
 * folder, and may have it) or `closed`.
 */
export interface DeskSession {
  id: string;
  title: string;
  cwd: string;
  /** Milliseconds since 1970. */
  updated: number;
  state: DeskState;
}

export const deskStates = ["open", "closed", "running", "waiting", "idle"] as const;
export type DeskState = (typeof deskStates)[number];

/** How a desk session becomes a thread: continued as it is, forked into a new one, or only read. */
export const adoptModes = ["continue", "fork", "read"] as const;
export type AdoptMode = (typeof adoptModes)[number];

export function isAdoptMode(value: unknown): value is AdoptMode {
  return (adoptModes as readonly unknown[]).includes(value);
}

/** A desk session made ready to be a thread (`Provider.adopt`). */
export interface DeskAdoption {
  /** The thread id: the session's own, or the fork's. */
  id: string;
  cwd: string;
  title: string | null;
  settings: SessionSettings;
}

/** A desk session that cannot be taken up as asked. The message is for the user. */
export class DeskRefused extends Error {}

/** How much of the user's plan an agent has used, as the agent tells it (`/usage`). */
export interface UsageReport {
  /** The plan, by the agent's name for it ("max", "plus"), when it says. */
  plan?: string;
  /** Each window the plan is counted in, in the agent's order. */
  limits: UsageLimit[];
  /** For limits last heard, not asked for now: when they were, in milliseconds since 1970. */
  heardAt?: number;
  /** What else to say, a sentence a line: why there are no limits to show (an API key has none), credits left. */
  note?: string;
}

export interface UsageLimit {
  /** As people say it: "5-hour", "weekly", "weekly Opus". */
  name: string;
  /** How much of it is used, 0 to 100; null when the agent does not say. */
  percent: number | null;
  /** When it starts again, in Unix seconds; null when not known. */
  resetsAt: number | null;
  /** Used up: the agent turns work away until it resets. */
  reached?: boolean;
  /** How long the window is, in seconds, where known: what a device paces the use against. */
  windowSeconds?: number;
  /** For a window kept from an earlier answer because this one did not say it, or that a turn has reported since this answer: when it was said, in milliseconds since 1970. */
  heardAt?: number;
}

/** One of the agent's own slash commands, offered in the app and sent to the agent as a message. */
export interface AgentCommand {
  /** Without its slash. */
  name: string;
  description: string;
  /** What can follow the name ("<file>"), or "". */
  usage: string;
  /** A skill of the user's, rather than one of the agent's own commands. */
  skill: boolean;
  source?: "project" | "user";
  custom?: boolean;
  /** Running this host command can contact the agent or change settings. */
  requiresWritable?: boolean;
  /** Bridge-only callbacks; catalog responses never serialize them or prompt bodies. */
  expand?(argument: string): { message: string; display: string };
  execute?(argument: string): Promise<string>;
}

export interface Provider {
  readonly profile: AgentProfile;
  /**
   * For an agent that keeps one ongoing conversation (a Hermes profile's Bot Chat,
   * feature bot_chat): where the agent keeps it, made there first when `make` and there
   * is none. Null when there is none and `make` is false. Throws when the agent cannot
   * say, and makes none then: a lookup that failed is no proof there is none. Every new
   * thread of the agent is that one, and its other threads leave the list.
   */
  ongoingThread?(make: boolean, options: { cwd: string; settings: SessionSettings }): Promise<OngoingThread | null>;
  /**
   * Calls `listener` with each agent this one's host adds to the bridge's while it runs (a
   * Hermes profile Hermes lists only then: put back, or made), so the bridge does for it
   * what it did for the others as it started.
   */
  onAgentAdded?(listener: (name: string, provider: Provider) => void): void;
  /** Its threads take `/mode`. */
  readonly supportsModes?: boolean;
  /** For agents with modes: what a thread that follows the agent's own settings asks, when known. */
  defaultMode?(): Exclude<ThreadMode, "default"> | null;
  /** What a mode means for this agent, as the end of "This thread now …", where it differs from Claude Code's. */
  readonly modeMeanings?: Partial<Record<Exclude<ThreadMode, "default">, string>>;
  readonly modeOptions?: ModeOption[];
  /** The agent takes a thread's mode only with a message: one chosen while a turn runs counts from the next (Cursor). */
  readonly modesWaitForTurn?: boolean;
  models(): Promise<ModelCatalog>;
  /** The agent's own slash commands. */
  commands?(thread?: { id: string; cwd: string }, name?: string): Promise<AgentCommand[]>;
  /**
   * The names of the agent's own commands the bridge runs itself (an `AgentCommand` with
   * `execute`): `slash.exec` asks for the agent's commands only for one of these, and
   * answers 4018 for any other name without waiting for a list that cannot have it.
   */
  readonly executes?: readonly string[];
  /**
   * For an agent that reads a message's `@path` mentions in itself (Claude Code): how
   * large a file it gives its model with the message (sessions/mentions.ts), for a
   * thread in `cwd` (its settings there may change it; undefined when not known yet).
   * Absent for one whose model reads a mentioned file with its tools: no note then.
   */
  mentionLimit?(cwd: string | undefined): MentionLimit;
  /**
   * How much of the user's plan the agent has used (`/usage`), asked of the agent now
   * where it can be, else as it last said. `thread`: the thread asking, whose own agent
   * is asked first.
   */
  usage?(thread: string, options?: { fresh?: boolean }): Promise<UsageReport>;
  /**
   * The thread whose agent knows it now by `id`, when that is not the thread's own id:
   * a Cursor thread whose conversation was started afresh keeps its id, while the
   * commands it runs say the new conversation's (`CURSOR_CONVERSATION_ID`). Undefined
   * for an id it does not know so.
   */
  threadKnownAs?(id: string): string | undefined;
  /**
   * For agents that name their own threads (Codex): makes the agent's thread for a new
   * session and returns its id, which `startSession` then gets. Without it the bridge
   * chooses the id.
   */
  newThread?(options: { cwd: string; settings: SessionSettings }): Promise<string>;
  startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession>;
  /** Loads a session this provider started before, possibly in an earlier run of the bridge. */
  resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession>;
  /**
   * The folders the agent worked in, with when it last did, for the folders offered to
   * new threads (src/folders.ts). Answers at once: a slow source is cached.
   */
  recentFolders?(): Promise<RecentFolder[]>;
  /**
   * Of these threads (the bridge's own), the ones the agent has running or open now,
   * which the bridge follows from the start after a restart.
   */
  liveThreads?(ids: string[]): Promise<string[]>;
  /**
   * Sessions started at the desk, newest first: at least the newest `wanted`, as far
   * as there are that many. The bridge leaves out its own threads and folders it never
   * offers. Answers quickly: what is slow is cached.
   */
  deskSessions?(wanted: number): Promise<DeskSession[]>;
  /**
   * Whether the agent still keeps a thread taken off the bridge's list, which `desk.list`
   * offers again only while it does (Claude Code deletes old sessions after a while).
   * Assumed kept when absent.
   */
  keeps?(id: string): Promise<boolean>;
  /**
   * Gets a desk session ready to be a thread: checks it can be taken up as asked, and
   * makes the fork for `fork`. Throws `DeskRefused` with a sentence for the user.
   * `readOnly`: for `continue`, the bridge lists the session now as a thread only read,
   * which it continues in the folder it was read in; else nothing an earlier read (or a
   * fork's folder check) left behind holds the session to that folder.
   */
  adopt?(id: string, mode: AdoptMode, readOnly?: boolean): Promise<DeskAdoption>;
  /**
   * Where the agent keeps the conversation of the thread `id` that runs in `cwd`, and how
   * it is written, for search (feature thread_search, src/search/): read by the bridge
   * without loading the thread. Null when there is none yet. An agent without it has its
   * threads searched only while they are loaded.
   */
  searchFile?(thread: { id: string; cwd: string }): Promise<SearchFile | null>;
  /** Starts what it runs in the background (version checks, connections, idle sweeps). */
  start?(): void;
  /** Stops everything it runs, for shutting down. */
  close?(): Promise<void>;
}
