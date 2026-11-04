import type { AgentCommand } from "./types.ts";

// `/mcp` as text: each of the agent's MCP servers and how it is, so a person can see why
// a tool they expected is missing. The bridge runs it for the agent (`Provider.executes`),
// read only: it signs in to nothing and changes no setting. Each agent says it in its own
// words, which its provider puts in these before they are written out. Droid has its own
// `/mcp`, which can also turn servers on and off (droid/controls.ts).

export type McpServerState = "connected" | "starting" | "notStarted" | "failed" | "signIn" | "approval" | "off" | "unknown";

/** One MCP server as its agent says it is. */
export interface McpServer {
  name: string;
  state: McpServerState;
  /** How many tools it gives the agent, where the agent says. */
  tools?: number;
  /** Why it failed, or the agent's own word for a state not in `McpServerState`. */
  detail?: string;
}

export interface McpStatusOptions {
  /** A line before the servers, as how they are read differs ("Not started for this thread yet"). */
  note?: string;
  /** What to do on the host to sign in to a server, said when one needs it. */
  signIn?: string;
  /** What to do on the host to approve a server, said when one needs it. */
  approve?: string;
}

const words: Record<McpServerState, string> = {
  connected: "connected",
  starting: "starting",
  notStarted: "not started",
  failed: "failed",
  signIn: "needs sign-in",
  approval: "not approved",
  off: "off",
  unknown: "unknown",
};

/** The `/mcp` command a provider offers, which `status` answers. */
export function mcpCommand(status: () => Promise<string>): AgentCommand {
  return { name: "mcp", description: "Show your MCP servers and whether each is connected", usage: "", skill: false, execute: status };
}

/** "1 tool", "12 tools". */
function tools(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

/** One line of no more than a few hundred characters, whatever an agent's error holds. */
export function oneLine(text: string, limit = 300): string {
  const line = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * `/mcp` as the thread shows it: "Codex MCP servers:", then a line a server
 * ("github: connected, 12 tools"), and what to do on the host for one that needs it.
 */
export function mcpStatusText(agent: string, servers: readonly McpServer[], options: McpStatusOptions = {}): string {
  const lines = [`${agent} MCP servers:`];
  if (options.note && servers.length > 0) lines.push(options.note);
  for (const server of [...servers].sort((one, other) => one.name.localeCompare(other.name))) {
    const state = server.state === "unknown" && server.detail ? oneLine(server.detail, 80) : words[server.state];
    const parts = [state];
    // Connected with none is worth saying; a count kept from before only when there is one.
    if (server.tools !== undefined && (server.state === "connected" || (server.state === "notStarted" && server.tools > 0))) parts.push(tools(server.tools));
    const why = server.state === "failed" && server.detail ? ` (${oneLine(server.detail)})` : "";
    lines.push(`${oneLine(server.name, 80)}: ${parts.join(", ")}${why}`);
  }
  if (servers.length === 0) lines.push("None set up.");
  if (options.signIn && servers.some((server) => server.state === "signIn")) lines.push(options.signIn);
  if (options.approve && servers.some((server) => server.state === "approval")) lines.push(options.approve);
  return lines.join("\n");
}
