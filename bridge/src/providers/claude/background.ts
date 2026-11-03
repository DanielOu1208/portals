import type { HostNote } from "../types.ts";

// Claude's background work: commands, subagents and workflows started with
// `run_in_background`, which go on after Claude's turn. When one ends, Claude Code tells
// Claude, which begins a turn by itself. These say why, in one line, the way the app
// shows Hermes's own (HermesHostEvents.swift): the live stream from Claude Code's
// `task_notification` messages, a stored conversation from the `<task-notification>`
// text Claude Code wrote in the user's place.

/** A piece of background work that ended, and the line that says so. */
export interface Ended {
  /** Agents did it (a subagent, a workflow), not a command. */
  agents: boolean;
  line: string;
}

/** What `task_started` or `background_tasks_changed` said a task is. */
export interface TaskInfo {
  type: string;
  description: string;
}

/** A task's end, from its `task_notification` and what was known of it before. */
export function ended(task: TaskInfo | undefined, status: string, summary: string): Ended {
  const type = task?.type ?? "";
  const agents = type === "local_agent" || type === "local_workflow";
  // An agent's summary is its whole reply; Claude Code's own line for it names the agent.
  if (type === "local_agent" && task?.description) return { agents, line: `Agent "${task.description}" ${endedWord(status)}` };
  if (summary.trim() !== "") return { agents, line: oneLine(summary) };
  return { agents, line: task?.description ? `"${task.description}" ${endedWord(status)}` : "Background work ended" };
}

/** The ends a stored `<task-notification>` message tells of; empty when the text is not one. */
export function notified(text: string): Ended[] {
  if (!text.trim().startsWith("<task-notification>")) return [];
  const ends: Ended[] = [];
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(match[1])?.[1]?.trim() ?? "";
    // The stored text has no task type, but Claude Code's lines name agents and workflows.
    const agents = summary.startsWith('Agent "') || /\bworkflow\b/i.test(summary);
    ends.push({ agents, line: summary === "" ? "Background work ended" : oneLine(summary) });
  }
  return ends;
}

/** The note for a turn begun after `ends`: the first, and how many more. `hidden` when nothing ended. */
export function noteFor(ends: Ended[]): HostNote {
  if (ends.length === 0) return { kind: "hidden", text: "" };
  const more = ends.length > 1 ? ` (and ${ends.length - 1} more)` : "";
  return { kind: ends.some((end) => end.agents) ? "async_delegation_complete" : "process_complete", text: ends[0].line + more };
}

function endedWord(status: string): string {
  switch (status) {
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    default:
      return "was stopped";
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
