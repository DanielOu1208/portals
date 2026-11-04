import { isThreadMode, threadModes, type AgentCommand, type ModeState, type ModelCatalog, type Provider, type ThreadMode, type UsageReport } from "../providers/types.ts";
import { gitHead, type GitHead } from "../git.ts";
import type { Session } from "../sessions/session.ts";
import { ErrorCode, invalidParams, RpcError } from "./errors.ts";
import { readOnlyText } from "../fleet/fleet.ts";

// Slash commands (docs/gateway-protocol.md, section 5.3). The bridge runs its own:
// `/status`, `/mode` for agents with modes, and `/usage` for agents that can say how much
// of the user's plan is used. An agent's own commands (Claude Code's `/compact`,
// `/context`, the user's skills) are offered too, except where the bridge has its own of
// the name; `slash.exec` answers 4018 for them, and `command.dispatch` hands them back to
// be sent as a message, which the agent runs.

const statusSummary = "Show this thread's agent, folder, branch and model";
const usageSummary = "Show how much of your plan's usage limits is used, and when each resets";
function offeredModes(provider: Provider): readonly ThreadMode[] {
  return provider.modeOptions?.map((option) => option.id) ?? threadModes.filter((mode) => mode !== "medium");
}

/** What each mode means, as the end of "This thread now …", unless the agent says otherwise. */
const meanings: Record<Exclude<ThreadMode, "default">, string> = {
  ask: "asks before editing files or running commands",
  edits: "edits files without asking, and asks before running commands",
  medium: "uses medium autonomy for reversible development actions",
  plan: "plans first, and asks before carrying the plan out",
  full: "edits files and runs commands without asking",
};

/** `commands.catalog` for one agent. */
export async function catalog(provider: Provider, session?: Session): Promise<Record<string, unknown>> {
  const bridge: [string, string][] = [["/status", statusSummary]];
  if (provider.supportsModes) bridge.push(["/mode", `Show or change how much this thread asks before acting (usage: /mode [${offeredModes(provider).join("|")}])`]);
  if (provider.usage) bridge.push(["/usage", usageSummary]);
  // The bridge's own answers to a name, not the agent's.
  const taken = new Set(bridge.map(([key]) => key));
  const own = ((await provider.commands?.(session ? { id: session.id, cwd: session.record.cwd } : undefined)) ?? [])
    .filter((command) => { const name = `/${command.name}`; if (taken.has(name)) return false; taken.add(name); return true; });
  const described = (command: AgentCommand): [string, string] => [
    `/${command.name}`,
    command.usage ? `${command.description} (usage: /${command.name} ${command.usage})` : command.description,
  ];
  const builtins = own.filter((command) => !command.skill).map(described);
  const skills = own.filter((command) => command.skill).map(described);

  const categories = [{ name: "Bridge", pairs: bridge }];
  if (builtins.length > 0) categories.push({ name: provider.profile.displayName, pairs: builtins });
  return {
    categories,
    // Skills are the pairs named in `skills` and in no category.
    pairs: [...bridge, ...builtins, ...skills],
    skills: Object.fromEntries(skills.map(([key]) => [key, { usage: 0 }])),
    canon: {},
    ...(own.some((command) => command.custom) ? { commands: Object.fromEntries(own.filter((command) => command.custom)
      .map((command) => [`/${command.name}`, { source: command.source, custom: true }])) } : {}),
  };
}

/** The name in a command line without its slash: "Status now" → "status". */
export function commandName(line: string): string {
  return (line.trim().split(/\s+/)[0] ?? "").replace(/^\/+/, "").toLowerCase();
}

function argument(line: string): string {
  return line.trim().replace(/^\S+\s*/, "");
}

/** `slash.exec`: the bridge's own commands; 4018 for the rest. */
export async function exec(session: Session, provider: Provider, line: string): Promise<Record<string, unknown>> {
  const name = commandName(line);
  const own = await ownCommand(session, provider, name, argument(line));
  if (own) return own;
  // Only a command the bridge runs for the agent: the agent's list (which Claude Code and
  // Pi may still be loading) is not waited for to answer that any other is not one.
  if (provider.executes?.includes(name)) {
    const agent = ((await provider.commands?.({ id: session.id, cwd: session.record.cwd }, name)) ?? []).find((command) => command.name === name);
    if (agent?.execute) {
      if (agent.requiresWritable && session.isReadOnly) throw invalidParams(readOnlyText);
      return { type: "exec", output: await agent.execute(argument(line)) };
    }
  }
  throw new RpcError(ErrorCode.notTerminalCommand, `/${name} is not one of the bridge's own commands.`);
}

/** `command.dispatch`: the bridge's own commands, or an agent command to send as a message. */
export async function dispatch(session: Session, provider: Provider, name: string, arg: string): Promise<Record<string, unknown>> {
  const bare = commandName(name);
  const own = await ownCommand(session, provider, bare, arg.trim());
  if (own) return own;
  const agent = ((await provider.commands?.({ id: session.id, cwd: session.record.cwd }, bare)) ?? []).find((command) => command.name === bare);
  if (agent?.execute) {
    if (agent.requiresWritable && session.isReadOnly) throw invalidParams(readOnlyText);
    return { type: "exec", output: await agent.execute(arg.trim()) };
  }
  if (agent?.expand) return { type: "send", ...agent.expand(arg.trim()) };
  if (agent) return { type: "send", message: arg.trim() ? `/${bare} ${arg.trim()}` : `/${bare}` };
  throw invalidParams(`There is no /${bare} command on this bridge.`);
}

async function ownCommand(session: Session, provider: Provider, name: string, arg: string): Promise<Record<string, unknown> | null> {
  if (name === "status") {
    const [catalog, head] = await Promise.all([provider.models().catch(() => null), gitHead(session.record.cwd).catch(() => null)]);
    return { type: "exec", output: statusText(session, catalog, head, provider.version?.statusLine() ?? null) };
  }
  if (name === "mode" && provider.supportsModes) return { type: "exec", output: await mode(session, provider, arg) };
  if (name === "usage" && provider.usage) return { type: "exec", output: usageText(provider.profile.displayName, await usage(provider, session.id)) };
  return null;
}

async function usage(provider: Provider, thread: string): Promise<UsageReport> {
  try {
    // A person asking now: not an answer kept for a panel that asks every minute.
    return await provider.usage!(thread, { fresh: true });
  } catch (error) {
    throw new RpcError(ErrorCode.internal, `${provider.profile.displayName} did not say how much is used: ${(error as Error).message}`);
  }
}

/**
 * `/usage` as the thread shows it: the plan, then a line a window ("5-hour: 42% used,
 * resets Wed 9:00 PM"), and when the limits are only as last heard, when that was.
 * Times are the Mac's unless `timeZone` says otherwise.
 */
export function usageText(agent: string, report: UsageReport, timeZone?: string): string {
  const plan = report.plan ? `, ${report.plan[0].toUpperCase()}${report.plan.slice(1)} plan` : "";
  const lines = [`${agent} usage${plan}:`];
  for (const limit of report.limits) {
    const used = limit.reached ? "used up" : limit.percent === null ? "in use" : `${Math.round(limit.percent)}% used`;
    const again = limit.resetsAt === null ? "" : `, resets ${moment(limit.resetsAt * 1000, timeZone)}`;
    const old = limit.heardAt === undefined ? "" : ` (as last said, ${moment(limit.heardAt, timeZone)})`;
    lines.push(`${limit.name[0].toUpperCase()}${limit.name.slice(1)}: ${used}${again}${old}`);
  }
  if (report.limits.length === 0) lines.push(report.note ?? "It has not said yet.");
  else if (report.note) lines.push(report.note);
  if (report.heardAt !== undefined) lines.push(`As ${agent} last said, ${moment(report.heardAt, timeZone)}.`);
  return lines.join("\n");
}

/** "Wed 9:00 PM", in `timeZone` or the Mac's. */
function moment(milliseconds: number, timeZone: string | undefined): string {
  return new Date(milliseconds).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone });
}

async function mode(session: Session, provider: Provider, arg: string): Promise<string> {
  const settings = `your ${provider.profile.displayName} settings`;
  const meaning = { ...meanings, ...provider.modeMeanings };
  const wanted = arg.toLowerCase();
  const modes = offeredModes(provider).filter((mode) => mode !== "default").join(", ");
  if (wanted === "") return describeMode(session.mode(), settings, meaning, modes);
  if (!isThreadMode(wanted) || !offeredModes(provider).includes(wanted)) throw invalidParams(`Use /mode ${modes} or default.`);
  await session.setMode(wanted);
  const state = session.mode();
  // For an agent that takes the mode with a message, the turn that is running goes on as it was.
  const later = provider.modesWaitForTurn && session.isRunning ? ` ${provider.profile.displayName} takes it with this thread's next message.` : "";
  if (wanted === "default") {
    return (state?.defaultsTo ? `This thread now follows ${settings}: it ${meaning[state.defaultsTo]}.` : `This thread now follows ${settings}.`) + later;
  }
  return `This thread now ${meaning[wanted]}.${later}`;
}

function describeMode(state: ModeState | null, settings: string, meaning: Record<Exclude<ThreadMode, "default">, string>, modes: string): string {
  if (!state) return "This agent has no modes.";
  const change = `Change it with /mode ${modes} or default.`;
  if (state.mode === "default") {
    const now = state.defaultsTo ? `: it ${meaning[state.defaultsTo]}` : "";
    return `Mode: default. This thread follows ${settings}${now}.\n${change}`;
  }
  return `Mode: ${state.mode}. This thread ${meaning[state.mode]}.\n${change}`;
}

/**
 * `head`: the git HEAD of the thread's folder now; no branch line outside a repository.
 * `version`: the agent's release and where it stands (`VersionCheck.statusLine`); no
 * line for an agent that has none, or before it is known.
 */
function statusText(session: Session, catalog: ModelCatalog | null, head: GitHead | null, version: string | null): string {
  const info = session.info();
  const level = info.reasoning_effort ? `, thinking ${String(info.reasoning_effort)}` : "";
  const mode = session.mode();
  const branch = head ? [`Branch: ${head.branch ?? `none, at commit ${head.commit}`}`] : [];
  return [
    `Agent: ${session.record.agent}`,
    ...(version ? [version] : []),
    `Folder: ${session.record.cwd}`,
    ...branch,
    `Model: ${modelName(String(info.model), catalog)} from ${String(info.provider)}${level}`,
    ...(mode ? [`Mode: ${mode.mode}`] : []),
    `Running: ${session.isRunning ? "yes" : "no"}`,
    `Thread: ${session.id}`,
  ].join("\n");
}

/**
 * A model by the name the agent gives it, as the app shows it ("Sonnet 5.5"), and the
 * agent's own marked as its default ("Opus 5.5 (default)" for Claude Code's `default`).
 * Its id when the agent names none.
 */
function modelName(model: string, catalog: ModelCatalog | null): string {
  const name = catalog?.names?.[model];
  if (!name) return model;
  return model === catalog.model ? `${name} (default)` : name;
}
