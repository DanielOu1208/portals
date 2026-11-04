import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ModelInfo, Options, SDKMessage, SDKUserMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeProvider } from "../src/providers/claude/provider.ts";
import type { PlanUsage, QueryLike, SessionFiles, StoredSession } from "../src/providers/claude/session.ts";
import { ClaudeStream, type StreamOptions } from "../src/providers/claude/stream.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

// Recorded Claude Code streams (scripts/record-claude.ts) and ways to play them back
// with no Claude at all: straight through the mapper, or as a stand-in for the SDK's
// query that a real ClaudeSession talks to.

/** The folder the recordings ran in, after cleaning. */
export const fixtureCwd = "/tmp/aeriportal-cwd";

export interface Entry {
  /** `restart`: the process was closed, and the entries after it are a new one that resumed the session. */
  kind: "meta" | "send" | "message" | "permission" | "control" | "error" | "history" | "info" | "restart";
  at: number;
  message?: any;
  text?: string;
  uuid?: string;
  steer?: boolean;
  tool?: string;
  input?: Record<string, unknown>;
  options?: { toolUseID: string; suggestions?: any[] };
  answer?: { behavior: string };
  call?: string;
  task_id?: string;
  messages?: unknown[];
  info?: any;
  session_id?: string;
}

export function fixture(name: string): Entry[] {
  const text = readFileSync(new URL(`fixtures/claude/${name}.jsonl`, import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Entry);
}

export function recordedHistory(name: string): unknown[] {
  return fixture(name).find((entry) => entry.kind === "history")?.messages ?? [];
}

/** The fixture's entries for each process, split where one was closed and the next resumed the session. */
export function processes(name: string): Entry[][] {
  const parts: Entry[][] = [[]];
  for (const entry of fixture(name)) {
    if (entry.kind === "restart") parts.push([]);
    else parts.at(-1)!.push(entry);
  }
  return parts;
}

/** The fixture's messages through a ClaudeStream (a new one per process), as the session would feed them. */
export function replayStream(name: string, options: Partial<StreamOptions> = {}): ProviderEvent[] {
  let stream = new ClaudeStream({ cwd: fixtureCwd, now: () => 0, timeZone: "UTC", ...options });
  const events: ProviderEvent[] = [];
  let sends = 0;
  for (const entry of fixture(name)) {
    if (entry.kind === "restart") stream = new ClaudeStream({ cwd: fixtureCwd, now: () => 0, timeZone: "UTC", ...options });
    // The bridge names every message; the oldest recordings sent theirs without a uuid.
    if (entry.kind === "send") stream.sent(entry.uuid ?? `unnamed-${(sends += 1)}`);
    if (entry.kind === "control" && entry.call === "interrupt") stream.interrupting();
    if (entry.kind === "permission" && entry.answer?.behavior === "deny" && entry.tool !== "AskUserQuestion") stream.denied.add(entry.options!.toolUseID);
    if (entry.kind === "message") events.push(...stream.map(entry.message as SDKMessage));
  }
  return events;
}

/** Events with each run of text or reasoning pieces joined into one, for reading and comparing. */
export function joined(events: ProviderEvent[]): unknown[] {
  const out: any[] = [];
  for (const event of events) {
    const last = out.at(-1);
    if ((event.type === "text" || event.type === "reasoning") && last?.type === event.type) {
      last.text += event.text;
      last.pieces += 1;
    } else if (event.type === "text" || event.type === "reasoning") {
      out.push({ ...event, pieces: 1 });
    } else {
      out.push(event);
    }
  }
  return out;
}

// MARK: A stand-in for the SDK's query

/** Part of what Claude Code 2.1.293 lists: its default, an alias for the same model (`opus`), others, and an older full id. */
export const testModels: ModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"], supportsAdaptiveThinking: true },
];

/** The effort each test model runs at with no effort of its own chosen: Opus as Dana's settings give it, Haiku none (it takes no effort). */
export const testEfforts: Record<string, string | null> = { default: "xhigh", opus: "xhigh", sonnet: "medium", haiku: null, "claude-opus-4-6": "high" };

export const testCommands: SlashCommand[] = [
  { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>", builtin: true },
  { name: "context", description: "Show current context usage", argumentHint: "", builtin: true },
  { name: "clear", description: "Start a new session with empty context", argumentHint: "", builtin: true },
  { name: "model", description: "Set the AI model for Claude Code", argumentHint: "<model>", builtin: true },
  { name: "grill-me", description: "Interview the user about a plan", argumentHint: "", builtin: false },
];

/** What every FakeQuery answers for `/usage` (its own `/usage`), until a test says otherwise; an error is thrown. */
export const planUsage: { answer: PlanUsage | Error } = { answer: new Error("not set") };

export const maxPlanUsage: PlanUsage = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42, resets_at: "2026-10-14T21:00:00Z" },
    seven_day: { utilization: 12.4, resets_at: "2026-10-19T09:00:00Z" },
    seven_day_opus: null,
    model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-10-19T09:00:00Z" }],
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 250, utilization: 5 },
    // Parts that are no share of a window are left out.
    spend: { utilization: null, resets_at: null },
  },
};

/** A Claude Code that does what the test (or a recording) tells it. */
export class FakeQuery implements QueryLike {
  readonly options: Options;
  /** What `getSettings` says a query that names no model runs on: Opus 5.5, as with a `model` setting of `opus`, unless a test says otherwise. */
  appliedModel: string | null = "claude-opus-5-5";
  /** The model set with `setModel`, whose effort `getSettings` gives. */
  private model: string | undefined;
  readonly received: SDKUserMessage[] = [];
  readonly calls: unknown[][] = [];
  /** What the session answered each permission prompt played to it, in order. */
  readonly permissionResults: { tool: string; result: unknown }[] = [];
  /** Runs for each message the session sends. */
  onMessage: (message: SDKUserMessage) => void = () => {};
  private readonly queue: (SDKMessage | Error | null)[] = [];
  private wake: (() => void) | null = null;
  private waiters: (() => void)[] = [];
  private done = false;

  constructor(input: AsyncIterable<SDKUserMessage>, options: Options) {
    this.options = options;
    void (async () => {
      for await (const message of input) {
        this.received.push(message);
        for (const wake of this.waiters.splice(0)) wake();
        this.onMessage(message);
      }
      // stdin closed: Claude finishes and exits.
      this.end();
    })();
  }

  emit(message: unknown): void {
    this.queue.push(message as SDKMessage);
    this.wake?.();
  }

  /** The process exits. */
  end(): void {
    if (this.done) return;
    this.done = true;
    this.queue.push(null);
    this.wake?.();
  }

  /** The process dies with an error. */
  crash(message: string): void {
    this.queue.push(new Error(message));
    this.wake?.();
  }

  get isRunning(): boolean {
    return !this.done;
  }

  /** Resolves once the session has sent `count` messages. */
  async waitForMessages(count: number): Promise<void> {
    while (this.received.length < count) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      const next = this.queue.shift();
      if (next === null) return;
      if (next instanceof Error) throw next;
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  async interrupt(): Promise<unknown> {
    this.calls.push(["interrupt"]);
    return undefined;
  }
  async stopTask(taskId: string): Promise<void> {
    this.calls.push(["stopTask", taskId]);
  }
  async setModel(model?: string): Promise<void> {
    this.calls.push(["setModel", model]);
    this.model = model;
  }
  async setPermissionMode(mode: string): Promise<void> {
    this.calls.push(["setPermissionMode", mode]);
  }
  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    this.calls.push(["applyFlagSettings", settings]);
  }
  async setMaxThinkingTokens(tokens: number | null, display?: string | null): Promise<void> {
    this.calls.push(["setMaxThinkingTokens", tokens, display]);
  }
  async supportedModels(): Promise<ModelInfo[]> {
    return testModels;
  }
  async supportedCommands(): Promise<SlashCommand[]> {
    return testCommands;
  }
  async initializationResult(): Promise<{ models: ModelInfo[]; commands: SlashCommand[]; current_permission_mode: string }> {
    return { models: testModels, commands: testCommands, current_permission_mode: "bypassPermissions" };
  }
  async getSettings(): Promise<{ applied: { model: string | null; effort: string | null } }> {
    return { applied: { model: this.appliedModel, effort: testEfforts[this.model ?? "default"] ?? null } };
  }
  /** What `getContextUsage` answers: an older Claude Code's refusal, unless a test gives a window. */
  contextUsage: { model: string; rawMaxTokens: number } | Error = new Error("Unknown control request subtype: get_context_usage");
  async getContextUsage(options?: { detail?: "summary" | "full" }): Promise<{ model: string; rawMaxTokens: number }> {
    this.calls.push(["getContextUsage", options]);
    if (this.contextUsage instanceof Error) throw this.contextUsage;
    return { ...this.contextUsage };
  }
  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options?: { skipBehaviors?: boolean }): Promise<PlanUsage> {
    this.calls.push(["usage", options]);
    if (planUsage.answer instanceof Error) throw planUsage.answer;
    return structuredClone(planUsage.answer);
  }
  close(): void {
    this.calls.push(["close"]);
    this.end();
  }
}

/**
 * Plays a recording into a FakeQuery as the session talks to it: each recorded send
 * waits for the session's own message (and its uuid stands in for the recorded one),
 * each permission prompt goes to the session's `canUseTool` and waits for its answer,
 * and a recorded interrupt waits for the session to ask for one.
 */
export async function play(query: FakeQuery, name: string, options: { from?: number } = {}): Promise<void> {
  await playEntries(query, fixture(name), options);
}

/**
 * Plays some of a recording's entries, as `play` does. `from` is how many messages the
 * query had before them; `uuids` carries the recorded sends' stand-ins from one call to
 * the next.
 */
export async function playEntries(query: FakeQuery, entries: Entry[], options: { from?: number; uuids?: Map<string, string> } = {}): Promise<void> {
  const uuids = options.uuids ?? new Map<string, string>();
  let sends = options.from ?? 0;
  // The recording's folder is the thread's.
  const here = (value: unknown) => inFolder(value, query.options.cwd ?? fixtureCwd);
  const controller = new AbortController();
  for (const entry of entries) {
    switch (entry.kind) {
      case "send": {
        sends += 1;
        await query.waitForMessages(sends);
        const sent = query.received[sends - 1];
        if (entry.uuid && sent.uuid) uuids.set(entry.uuid, sent.uuid);
        break;
      }
      case "message": {
        query.emit(withUUIDs(here(entry.message), uuids));
        // Lets the session handle it, as Claude's messages arrive one by one.
        await new Promise((resolve) => setImmediate(resolve));
        break;
      }
      case "permission": {
        const result = await query.options.canUseTool!(entry.tool!, here(entry.input) as Record<string, unknown>, {
          signal: controller.signal,
          suggestions: here(entry.options!.suggestions) as never,
          toolUseID: entry.options!.toolUseID,
          requestId: entry.options!.toolUseID,
        } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
        query.permissionResults.push({ tool: entry.tool!, result });
        break;
      }
      case "control":
        // The session's own call: Stop on the turn, or on one subagent or workflow.
        while (!query.calls.some((call) => call[0] === (entry.call === "stopTask" ? "stopTask" : "interrupt"))) await new Promise((resolve) => setTimeout(resolve, 5));
        break;
      default:
        break;
    }
  }
}

/** `value` with the recording's folder replaced by `cwd` in every string. */
export function inFolder<T>(value: T, cwd: string): T {
  if (cwd === fixtureCwd || value === undefined) return value;
  return JSON.parse(JSON.stringify(value).split(fixtureCwd).join(cwd)) as T;
}

function withUUIDs(message: any, uuids: Map<string, string>): any {
  if (uuids.size === 0 || (message?.type !== "result" && !(message?.type === "system" && message.subtype === "status"))) return message;
  const swap = (uuid: string) => uuids.get(uuid) ?? uuid;
  const copy = { ...message };
  if (typeof copy.user_message_uuid === "string") copy.user_message_uuid = swap(copy.user_message_uuid);
  if (Array.isArray(copy.user_message_uuids)) copy.user_message_uuids = copy.user_message_uuids.map(swap);
  return copy;
}

/** Claude's files about its sessions, kept in memory. */
export class FakeFiles implements SessionFiles {
  readonly stored = new Map<string, { title: string | null; messages: unknown[] }>();
  /** What Claude's session index says about folders. */
  readonly recent: { path: string; lastUsed: number }[] = [];
  /** Sessions started at a terminal, as Claude's index lists them. */
  readonly sessions: StoredSession[] = [];
  /** Sessions started through the SDK (the bridge's own): Claude's index has them, and its list of the desk's leaves them out. */
  readonly started: StoredSession[] = [];
  /** The sessions forked, as [from, to]. */
  readonly forks: [string, string][] = [];
  /** The titles given, as [session, title]. */
  readonly renames: [string, string][] = [];

  async exists(id: string): Promise<boolean> {
    return this.stored.has(id);
  }
  async title(id: string): Promise<string | null> {
    return this.stored.get(id)?.title ?? null;
  }
  async messages(id: string): Promise<unknown[]> {
    return this.stored.get(id)?.messages ?? [];
  }
  /** Workflows' journals, by path. */
  readonly journals = new Map<string, unknown>();
  async journal(path: string): Promise<unknown> {
    return this.journals.get(path) ?? null;
  }
  async folders(): Promise<{ path: string; lastUsed: number }[]> {
    return this.recent;
  }
  async desk(limit: number): Promise<StoredSession[]> {
    return [...this.sessions].sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
  }
  async info(id: string): Promise<StoredSession | undefined> {
    return [...this.sessions, ...this.started].find((session) => session.sessionId === id);
  }
  async rename(id: string, _cwd: string, title: string): Promise<void> {
    this.renames.push([id, title]);
    const stored = this.stored.get(id);
    if (stored) stored.title = title;
  }
  async fork(id: string, cwd: string, upToMessageId?: string): Promise<string> {
    const from = [...this.sessions, ...this.started].find((session) => session.sessionId === id);
    if (!from) throw new Error("Session not found");
    const fork = randomUUID();
    const title = `${from.customTitle ?? from.summary} (fork)`;
    this.sessions.push({ ...from, sessionId: fork, customTitle: title, cwd, lastModified: Date.now() });
    const messages = this.stored.get(id)?.messages ?? [];
    const end = upToMessageId ? messages.findIndex((entry) => (entry as { uuid?: string })?.uuid === upToMessageId) : messages.length - 1;
    if (upToMessageId && end < 0) throw new Error("Fork message not found");
    this.stored.set(fork, { title, messages: structuredClone(messages.slice(0, end + 1)).map((entry) => {
      const message = entry as { uuid?: string };
      return typeof message?.uuid === "string" ? { ...message, uuid: randomUUID() } : entry;
    }) });
    this.forks.push([id, fork]);
    return fork;
  }
}

/** A Claude provider whose queries are FakeQuery objects, in the order they start. */
export function fakeClaude(
  options: { maxWarm?: number; idleMinutes?: number; files?: FakeFiles; agents?: () => Promise<unknown>; appliedModel?: string | null; now?: () => number; interruptGraceMs?: number; titleWatchMs?: number[]; home?: string; managedSettings?: string; checkpointPath?: string } = {},
) {
  const queries: FakeQuery[] = [];
  const files = options.files ?? new FakeFiles();
  const provider = new ClaudeProvider({
    settings: { path: "/nonexistent/claude", idleMinutes: options.idleMinutes ?? 15, maxWarm: options.maxWarm ?? 6, apiKey: null, folder: "/tmp" },
    files,
    checkpointPath: options.checkpointPath,
    // A home of its own, never Dana's: Claude Code's settings there count (`mentionLimit`).
    env: { PATH: "/usr/bin", HOME: options.home ?? "/nonexistent/home", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "sk-from-env" },
    managedSettings: options.managedSettings ?? "/nonexistent/managed-settings.json",
    // No terminal has anything open unless the test says so.
    agents: options.agents ?? (async () => []),
    now: options.now,
    interruptGraceMs: options.interruptGraceMs,
    titleWatchMs: options.titleWatchMs,
    query: (prompt, queryOptions) => {
      const query = new FakeQuery(prompt, queryOptions);
      // Read as each query starts: a test can change it between checks.
      if (options.appliedModel !== undefined) query.appliedModel = options.appliedModel;
      queries.push(query);
      return query;
    },
  });
  return { provider, queries, files };
}

/** A workflow's journal as Claude Code 2.1.299 writes it when the workflow ends (the recorded `subagents` workflow's, trimmed). */
export const tinyCheckJournal = {
  runId: "wf_283f0ded-7dc",
  taskId: "wwn9e3l29",
  workflowName: "tiny-check",
  status: "completed",
  startTime: 1791976459000,
  durationMs: 4200,
  phases: [{ title: "Check", detail: "Both reply" }],
  workflowProgress: [
    { type: "workflow_phase", index: 1, title: "Check" },
    { type: "workflow_agent", index: 1, label: "apple", phaseIndex: 1, phaseTitle: "Check", agentId: "a1", model: "claude-haiku-5-5", state: "done", tokens: 15824, toolCalls: 0, durationMs: 3190, resultPreview: "apple" },
    { type: "workflow_agent", index: 2, label: "pear", phaseIndex: 1, phaseTitle: "Check", agentId: "a2", model: "claude-haiku-5-5", state: "done", tokens: 15790, toolCalls: 0, durationMs: 3410, resultPreview: "pear" },
  ],
  totalTokens: 31614,
  totalToolCalls: 0,
};
