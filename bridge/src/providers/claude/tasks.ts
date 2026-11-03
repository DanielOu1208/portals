import { cutWhole } from "../../json.ts";
import type { SubagentInfo, SubagentStatus, WorkflowAgent } from "../types.ts";
import { gatewayTool } from "./tools.ts";

// The subagents and workflows Claude starts, as the subagents line shows them (feature
// `subagents`), from Claude Code's task messages:
//
// - `task_started` opens one: a subagent (`local_agent`, with its description and
//   whether it runs in the background) or a workflow (`local_workflow`, with its name).
//   Other tasks (background commands, watchers) are not agents and are left out.
// - `task_progress` says what it is doing: the subagent's one-line summary (the option
//   `agentProgressSummaries`), its last tool and what it has used; for a workflow, in
//   `workflow_progress`, its phases and the state of each of its agents.
// - `task_updated` patches it: moved to the background, or ended.
// - `task_notification` ends it, with its reply as the summary.
//
// A subagent Claude gives more to do keeps its task id and starts a new run (`run_id`,
// whose ids sort in the order the runs began): what an earlier run says after that is
// late, and left out. Each change gives the whole of what is known of the one it changed.

type Message = Record<string, any>;

/** How much of a reply a row carries: the app shows its start. */
const resultLength = 2000;

export class TaskBoard {
  private readonly now: () => number;
  private readonly known = new Map<string, SubagentInfo>();
  /** The latest run of each, by its `run_id`, where Claude Code says it. */
  private readonly runs = new Map<string, string>();
  /** The subagents the model has summed up: their line is its summary from then on. */
  private readonly summed = new Set<string>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Whether `m` is about a task's run before its latest: late, and to be left out (any task, an agent's or not). */
  isLate(m: Message): boolean {
    const run = runOf(m);
    const latest = typeof m.task_id === "string" ? this.runs.get(m.task_id) : undefined;
    return run !== undefined && latest !== undefined && run < latest;
  }

  /** The subagent or workflow `m` changed, as it is now; null for any other message. */
  take(m: Message): SubagentInfo | null {
    const id = typeof m.task_id === "string" ? m.task_id : "";
    if (id === "" || this.isLate(m)) return null;
    const run = runOf(m);
    if (run !== undefined) this.runs.set(id, run);
    if (m.subtype === "task_started") return this.started(id, m);
    const known = this.known.get(id);
    if (!known) return null;
    switch (m.subtype) {
      case "task_progress":
        return this.progress(known, m);
      case "task_updated":
        return this.updated(known, m.patch ?? {});
      case "task_notification":
        return this.ended(known, m);
      default:
        return null;
    }
  }

  /** The ones still running, as stopped: their process has ended, and they with it. */
  stopAll(): SubagentInfo[] {
    const stopped: SubagentInfo[] = [];
    for (const info of this.known.values()) {
      if (info.status !== "running") continue;
      stopped.push(this.end(info, "stopped"));
    }
    return stopped;
  }

  /** Whether `id` is a subagent or workflow still running, which can be stopped by itself. */
  isStoppable(id: string): boolean {
    const info = this.known.get(id);
    return info?.status === "running" && info.stoppable;
  }

  /** Whether any subagent or workflow is still running. */
  get isRunning(): boolean {
    return [...this.known.values()].some((info) => info.status === "running");
  }

  private started(id: string, m: Message): SubagentInfo | null {
    const workflow = m.task_type === "local_workflow";
    if (!workflow && m.task_type !== "local_agent") return null;
    if (m.ambient === true || m.skip_transcript === true) return null;
    const background = workflow || m.is_backgrounded === true;
    const info: SubagentInfo = {
      id,
      kind: workflow ? "workflow" : "agent",
      goal: text(m.description),
      status: "running",
      startedAt: this.now(),
      background,
      // A subagent in the foreground is part of the turn, which Stop stops.
      stoppable: background,
    };
    if (workflow && text(m.workflow_name) !== "") info.name = text(m.workflow_name);
    // The kind of subagent ("Explore"), which Claude Code shows at the desk.
    if (!workflow && text(m.subagent_type) !== "") info.role = text(m.subagent_type);
    // Started by one of its subagents; an id not known here is no parent (Claude Code's word).
    const parent = text(m.parent_task_id);
    if (parent !== "" && parent !== id && this.known.has(parent)) info.parent = parent;
    this.known.set(id, info);
    this.summed.delete(id);
    return copy(info);
  }

  private progress(info: SubagentInfo, m: Message): SubagentInfo {
    if (info.status !== "running") return copy(info);
    this.used(info, m.usage);
    if (info.kind === "workflow") {
      // Its `summary` is its description again, and its "tool" the agent that last
      // moved: the phases and agents say more.
      if (Array.isArray(m.workflow_progress)) this.workflow(info, m.workflow_progress);
      return copy(info);
    }
    // The model's summary every half minute or so; before the first, Claude Code's own
    // line on its last tool ("Running List the files"), which comes with every tool and
    // would otherwise replace the summary a moment after it came.
    if (text(m.summary) !== "") {
      info.summary = oneLine(text(m.summary));
      this.summed.add(info.id);
    } else if (!this.summed.has(info.id) && text(m.description) !== "" && text(m.description) !== info.goal) {
      info.summary = oneLine(text(m.description));
    }
    if (text(m.last_tool_name) !== "") info.tool = gatewayTool(m.last_tool_name, {}).name;
    return copy(info);
  }

  private updated(info: SubagentInfo, patch: Message): SubagentInfo {
    if (patch.is_backgrounded === true && !info.background) {
      info.background = true;
      info.stoppable = true;
    }
    if (text(patch.description) !== "") info.goal = text(patch.description);
    if (info.status === "running") {
      const status = statusOf(patch.status);
      if (status) {
        if (text(patch.error) !== "") info.result = clipped(patch.error);
        return this.end(info, status, typeof patch.end_time === "number" ? patch.end_time : undefined);
      }
    }
    return copy(info);
  }

  private ended(info: SubagentInfo, m: Message): SubagentInfo {
    this.used(info, m.usage);
    // A stopped workflow's summary is only its description again.
    const summary = text(m.summary);
    if (summary !== "" && summary !== info.goal) info.result = clipped(summary);
    if (info.status !== "running") return copy(info);
    return this.end(info, statusOf(m.status) ?? "completed");
  }

  private end(info: SubagentInfo, status: SubagentStatus, at?: number): SubagentInfo {
    info.status = status;
    info.endedAt = at ?? this.now();
    info.stoppable = false;
    // What it was doing is over; its result says how it went.
    delete info.summary;
    // A workflow's agents still at work when it ended end with it.
    for (const agent of info.agents ?? []) if (agent.status === "running") agent.status = status === "completed" ? "completed" : "stopped";
    return copy(info);
  }

  private used(info: SubagentInfo, usage: Message | undefined): void {
    if (typeof usage?.total_tokens === "number") info.tokens = usage.total_tokens;
    if (typeof usage?.tool_uses === "number") info.toolUses = usage.tool_uses;
  }

  private workflow(info: SubagentInfo, progress: Message[]): void {
    workflowProgress(info, progress);
  }
}

/**
 * A workflow's phases and agents, from `workflow_progress` (or a journal's
 * `workflowProgress`): entries of `workflow_phase` (`index`, `title`) and
 * `workflow_agent` (`index`, `label`, `phaseTitle`, `model`, `state`, `tokens`,
 * `toolCalls`, `durationMs`, `resultPreview`), each the latest about its phase or agent.
 * An agent is known by its `index`: its `agentId` comes only once it has started.
 */
function workflowProgress(info: SubagentInfo, progress: Message[]): void {
  for (const entry of progress) {
    if (entry?.type === "workflow_phase" && typeof entry.index === "number") {
      const phases = (info.phases ??= []);
      const phase = { index: entry.index, title: text(entry.title) };
      const at = phases.findIndex((known) => known.index === phase.index);
      if (at >= 0) phases[at] = phase;
      else phases.push(phase);
      phases.sort((a, b) => a.index - b.index);
    } else if (entry?.type === "workflow_agent") {
      const id = typeof entry.index === "number" ? String(entry.index) : text(entry.agentId) || text(entry.label);
      if (id === "") continue;
      const agents = (info.agents ??= []);
      let agent = agents.find((known) => known.id === id);
      if (!agent) {
        agent = { id, label: text(entry.label) || id, status: "running" };
        agents.push(agent);
      }
      update(agent, entry);
    }
  }
}

function update(agent: WorkflowAgent, entry: Message): void {
  if (text(entry.label) !== "") agent.label = text(entry.label);
  if (text(entry.phaseTitle) !== "") agent.phase = text(entry.phaseTitle);
  if (text(entry.model) !== "") agent.model = text(entry.model);
  agent.status = agentStatus(entry.state) ?? agent.status;
  if (typeof entry.tokens === "number") agent.tokens = entry.tokens;
  if (typeof entry.toolCalls === "number") agent.toolUses = entry.toolCalls;
  if (typeof entry.durationMs === "number") agent.durationMs = entry.durationMs;
  if (text(entry.resultPreview) !== "") agent.result = clipped(entry.resultPreview);
}

/** A workflow agent's `state`. */
function agentStatus(state: unknown): SubagentStatus | null {
  switch (state) {
    case "start":
    case "running":
      return "running";
    case "done":
    case "completed":
      return "completed";
    case "error":
    case "failed":
      return "failed";
    case "skipped":
    case "stopped":
    case "killed":
      return "stopped";
    default:
      return null;
  }
}

/** A task's status that ends it, as the app's word for how it ended; null while it runs. */
function statusOf(status: unknown): SubagentStatus | null {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
    case "killed":
      return "stopped";
    default:
      return null;
  }
}

function runOf(m: Message): string | undefined {
  return typeof m.run_id === "string" && m.run_id !== "" ? m.run_id : undefined;
}

function copy(info: SubagentInfo): SubagentInfo {
  return structuredClone(info);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipped(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > resultLength ? `${cutWhole(trimmed, resultLength)}…` : trimmed;
}

// MARK: From a stored conversation

/** A subagent or workflow a stored conversation tells of, with the turn that started it (see `pastSubagents`). */
export interface PastSubagent {
  subagent: SubagentInfo;
  /** 0 for the conversation's last turn, -1 for the one before it, and so on. */
  turn: number;
  /** A workflow's journal, where Claude Code wrote its phases and agents when it ended (`fromJournal`). */
  journal?: string;
  /**
   * The log of a workflow's agents as they started and answered, which Claude Code writes
   * as it goes (`fromAgentLog`): all there is of one cut off before it ended.
   */
  agentLog?: string;
}

interface Call {
  info: SubagentInfo;
  turn: number;
  journal?: string;
  agentLog?: string;
}

/**
 * The subagents and workflows a stored conversation tells of, for a thread loaded again
 * after the bridge restarted, when none of them can be running any more: the Agent
 * (or Task) and Workflow calls, what their results said (an agent in the foreground
 * answers there; one in the background, and a workflow, are given an id there), and
 * the `<task-notification>` Claude Code wrote when one ended in the background. Their
 * phases and agents are not kept. One that never said it ended stopped with the process.
 */
export function pastSubagents(messages: readonly unknown[]): PastSubagent[] {
  const calls = new Map<string, Call>();
  let turns = 0;
  let at = 0;
  for (const raw of messages) {
    const entry = raw as Message;
    if (!entry || entry.parent_tool_use_id) continue;
    const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(parsed)) at = parsed;
    const content = entry.message?.content;
    const blocks: Message[] = Array.isArray(content) ? content : [];
    if (entry.type === "assistant") {
      for (const block of blocks) {
        if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
        const call = startedBy(block.name, block.input ?? {}, at);
        if (call) calls.set(block.id, { info: call, turn: turns });
      }
      continue;
    }
    if (entry.type !== "user") continue;
    const results = blocks.filter((block) => block?.type === "tool_result");
    for (const block of results) {
      const call = calls.get(block.tool_use_id);
      if (!call) continue;
      const result = resultText(block.content);
      answered(call.info, result, block.is_error === true, at);
      if (call.info.kind === "workflow") Object.assign(call, journalOf(result));
    }
    if (results.length > 0) continue;
    // Whatever else the user's side holds opens a turn: a message, or Claude Code's word that work ended.
    turns += 1;
    const said = typeof content === "string" ? content : blocks.map((block) => (block?.type === "text" ? block.text : "")).join("");
    for (const match of said.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const call = calls.get(tag(match[1], "tool-use-id"));
      if (call) notified(call.info, match[1], at);
    }
  }
  return [...calls.values()].map(({ info, turn, journal, agentLog }) => {
    if (info.status === "running") Object.assign(info, { status: "stopped", endedAt: info.endedAt ?? at, stoppable: false });
    const past: PastSubagent = { subagent: info, turn: turn - turns };
    if (journal) past.journal = journal;
    if (agentLog) past.agentLog = agentLog;
    return past;
  });
}

/**
 * Where Claude Code keeps what a workflow did, from what the Workflow call answered: its
 * transcripts are in `<session>/subagents/workflows/<run>`, with the log of its agents
 * (`journal.jsonl`) beside them, and its journal is `<session>/workflows/<run>.json`.
 * Nothing when the answer names no such folder. The answer's last such line: the
 * workflow's summary, which the model wrote and which may run over several lines, comes
 * before Claude Code's own.
 */
function journalOf(result: string): { journal?: string; agentLog?: string } {
  const folder = [...result.matchAll(/^Transcript dir: (.+)$/gm)].at(-1)?.[1]?.trim() ?? "";
  const parts = /^(\/.+)\/subagents\/workflows\/(wf_[\w-]+)\/?$/.exec(folder);
  return parts ? { journal: `${parts[1]}/workflows/${parts[2]}.json`, agentLog: `${parts[1]}/subagents/workflows/${parts[2]}/journal.jsonl` } : {};
}

/**
 * A workflow cut off before Claude Code wrote its journal (its process stopped with the
 * bridge), as the log of its agents tells it, a record a line: `started` (an agent's
 * `label` and `phase`, under its `key`; again when it is tried again), `result` (what it
 * answered: words, or a value for one given a schema) and `failed`. The phases are those
 * the agents ran in, in the order they first did; an agent with no result was cut off
 * with the workflow.
 */
export function fromAgentLog(info: SubagentInfo, records: readonly unknown[]): void {
  const agents: WorkflowAgent[] = [];
  const byKey = new Map<string, WorkflowAgent>();
  for (const raw of records) {
    const record = raw as Message;
    const key = text(record?.key) || text(record?.agentId);
    if (key === "") continue;
    const known = byKey.get(key);
    if (record.type === "started" && !known) {
      const agent: WorkflowAgent = { id: String(agents.length + 1), label: text(record.label) || key, status: "running" };
      if (text(record.phase) !== "") agent.phase = text(record.phase);
      byKey.set(key, agent);
      agents.push(agent);
    } else if (record.type === "started" && known?.status === "failed") {
      // Started again after it failed: at work, until its log says how this try ended.
      known.status = "running";
    } else if (record.type === "result" && known) {
      known.status = "completed";
      // An agent given a schema answers with a value, not words.
      const answer = typeof record.result === "string" ? record.result : record.result === undefined || record.result === null ? "" : JSON.stringify(record.result);
      if (answer.trim() !== "") known.result = clipped(answer);
      else delete known.result;
    } else if (record.type === "failed" && known) {
      known.status = "failed";
      delete known.result;
    }
  }
  if (agents.length === 0) return;
  const titles = [...new Set(agents.flatMap((agent) => (agent.phase ? [agent.phase] : [])))];
  if (titles.length > 0) info.phases = titles.map((title, index) => ({ index: index + 1, title }));
  for (const agent of agents) if (agent.status === "running") agent.status = info.status === "completed" ? "completed" : "stopped";
  info.agents = agents;
}

/**
 * A workflow of a stored conversation, as its journal tells it: the phases and agents,
 * how it ended, when, and what it used, which the conversation does not keep. Claude
 * Code writes the journal when the workflow ends; one it cut off (`killed`) is stopped.
 * Agents still at work in it end with the workflow. A journal of another workflow, or
 * not one at all, changes nothing.
 */
export function fromJournal(info: SubagentInfo, journal: unknown): void {
  const entry = journal as Message;
  if (!entry || typeof entry !== "object" || (typeof entry.taskId === "string" && info.id !== "" && entry.taskId !== info.id)) return;
  if (!info.name && text(entry.workflowName) !== "") info.name = text(entry.workflowName);
  const status = statusOf(entry.status);
  if (status) info.status = status;
  if (typeof entry.startTime === "number") {
    info.startedAt = entry.startTime;
    if (typeof entry.durationMs === "number") info.endedAt = entry.startTime + entry.durationMs;
  }
  if (typeof entry.totalTokens === "number") info.tokens = entry.totalTokens;
  if (typeof entry.totalToolCalls === "number") info.toolUses = entry.totalToolCalls;
  if (Array.isArray(entry.workflowProgress)) workflowProgress(info, entry.workflowProgress);
  if (!info.phases && Array.isArray(entry.phases)) {
    info.phases = entry.phases.map((phase: Message, index: number) => ({ index: index + 1, title: text(phase?.title) }));
  }
  if (info.status === "failed" && !info.result && text(entry.error) !== "") info.result = clipped(text(entry.error));
  for (const agent of info.agents ?? []) if (agent.status === "running") agent.status = info.status === "completed" ? "completed" : "stopped";
}

/** What an Agent, Task or Workflow call starts; null for any other tool. */
function startedBy(tool: unknown, input: Message, at: number): SubagentInfo | null {
  if (tool === "Agent" || tool === "Task") {
    const info: SubagentInfo = { id: "", kind: "agent", goal: text(input.description), status: "running", startedAt: at, background: input.run_in_background === true, stoppable: false };
    if (text(input.model) !== "") info.model = text(input.model);
    if (text(input.subagent_type) !== "") info.role = text(input.subagent_type);
    return info;
  }
  if (tool !== "Workflow") return null;
  // The script's `meta` is a plain literal: its name and description are read as written.
  const script = typeof input.script === "string" ? input.script : "";
  const info: SubagentInfo = { id: "", kind: "workflow", goal: literal(script, "description"), status: "running", startedAt: at, background: true, stoppable: false };
  const name = literal(script, "name") || text(input.name);
  if (name !== "") info.name = name;
  return info;
}

/** A call's result: a foreground agent's answer, or the id a background one or a workflow runs under. */
function answered(info: SubagentInfo, result: string, failed: boolean, at: number): void {
  const id = /agentId: (\w+)/.exec(result)?.[1] ?? /Task ID: (\w+)/.exec(result)?.[1];
  if (id) info.id = id;
  if (info.kind === "workflow" || /^Async agent launched/.test(result)) {
    info.background = true;
    return;
  }
  info.status = failed ? "failed" : "completed";
  info.endedAt = at;
  if (result.trim() !== "") info.result = clipped(result.replace(/\n*agentId: \w+[\s\S]*$/, ""));
}

/** One ended in the background, as its `<task-notification>` says. */
function notified(info: SubagentInfo, body: string, at: number): void {
  if (info.id === "") info.id = tag(body, "task-id");
  info.status = statusOf(tag(body, "status")) ?? "completed";
  info.endedAt = at;
  const result = tag(body, "result") || tag(body, "summary");
  if (result !== "" && result !== info.goal) info.result = clipped(result);
}

function tag(body: string, name: string): string {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? "";
}

/** `key: 'value'` as written in a workflow's `meta`. */
function literal(script: string, key: string): string {
  return new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`).exec(script)?.[2]?.trim() ?? "";
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).map((block: Message) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("\n");
}
