import { hostOS, machineWord, type HostOS } from "../platform.ts";

// What a thread says when its agent is not signed in on the host: one sentence for each
// agent, naming what to run there. Portals cannot sign an agent in, and what the agents
// say themselves names commands of their own terminal apps (/login) that a portal does
// not have, or is an HTTP error. A turn that failed so is still offered again: it works
// once the agent is signed in.

export type SignInAgent = "claude" | "codex" | "droid" | "pi" | "cursor" | "opencode";

const agentNames: Record<SignInAgent, string> = { claude: "Claude Code", codex: "Codex", droid: "Droid", pi: "Pi", cursor: "Cursor", opencode: "OpenCode" };

/** What signs each agent in, run in a terminal on the host. */
export const signInCommands: Record<SignInAgent, string> = {
  claude: "Run `claude auth login` in a terminal there",
  codex: "Run `codex login` in a terminal there",
  droid: "Run `droid` in a terminal there and sign in with /login",
  pi: "Run `pi` in a terminal there and sign in with /login",
  cursor: "Run `cursor-agent login` in a terminal there",
  opencode: "Run `opencode auth login` in a terminal there",
};

/** What to do, after a first sentence that says what is wrong: "Run `codex login` in a terminal there, then try again." */
export function signInHint(agent: SignInAgent): string {
  return `${signInCommands[agent]}, then try again.`;
}

/**
 * "Codex is not signed in on this Mac. Run `codex login` in a terminal there, then try
 * again." `to` names what it is not signed in to, for an agent with a sign-in for each
 * model provider (Pi's).
 */
export function notSignedIn(agent: SignInAgent, options: { to?: string; os?: HostOS } = {}): string {
  const to = options.to ? ` to ${options.to}` : "";
  return `${agentNames[agent]} is not signed in${to} on this ${machineWord(options.os ?? hostOS)}. ${signInHint(agent)}`;
}
