import type { AgentInfo } from "@opencode/client";
import type { ModeOption, ModeState, ThreadMode } from "../types.ts";
import type { OpenCodeApi } from "./client.ts";

export const agentModes: ModeOption[] = [
  { id: "plan", label: "Plan", description: "Use OpenCode's Plan agent and its own permission settings" },
  { id: "default", label: "Default", description: "Use the default agent in your OpenCode settings" },
];

export interface AgentSettings {
  agents: AgentInfo[];
  defaultAgent: string;
}

export async function agentSettings(api: OpenCodeApi, directory: string): Promise<AgentSettings> {
  const [agents, configured] = await Promise.all([api.agents(directory), api.defaultAgent(directory)]);
  return { agents, defaultAgent: configured ?? agents.find(selectable)?.id ?? "" };
}

function selectable(agent: AgentInfo): boolean {
  return !agent.hidden && agent.mode !== "subagent";
}

/** Modes select native agents, never permission rules. The native session keeps the choice. */
export class OpenCodeAgents {
  private selected: string;
  private readonly settings: AgentSettings;
  private readonly switchAgent: (agent: string) => Promise<void>;

  constructor(settings: AgentSettings, selected: string | undefined, switchAgent: (agent: string) => Promise<void>) {
    this.settings = settings;
    this.selected = selected ?? settings.defaultAgent;
    this.switchAgent = switchAgent;
  }

  mode(): ModeState {
    return { mode: this.selected === "plan" ? "plan" : "default", options: agentModes };
  }

  selectedElsewhere(agent: string): void {
    if (agent) this.selected = agent;
  }

  async setMode(mode: ThreadMode): Promise<void> {
    if (mode !== "default" && mode !== "plan") throw new Error("OpenCode offers only Plan and Default. Its own settings control permissions.");
    await this.select(mode === "plan" ? "plan" : this.settings.defaultAgent);
  }

  async command(argument: string): Promise<string> {
    const wanted = argument.trim();
    if (!wanted) return [`OpenCode agent: ${this.selected || "default"}.`, "Select one with /agent <id>:", ...this.settings.agents.filter(selectable).map((agent) => `${agent.id}: ${agent.description || agent.name}`)].join("\n");
    await this.select(wanted);
    return `This thread now uses OpenCode's ${wanted} agent, with its own settings and permissions.`;
  }

  private async select(id: string): Promise<void> {
    if (!this.settings.agents.some((agent) => agent.id === id && selectable(agent))) throw new Error(`OpenCode has no selectable ${id || "default"} agent in this folder. Use /agent to list its primary agents.`);
    await this.switchAgent(id);
    this.selected = id;
  }
}
