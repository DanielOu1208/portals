// Loaded by Pi with -e, in the thread's process. These are the parts of Pi's extension
// API used here (available since 1.1.0); no Pi package is needed by the host.
// This is a convenience gate, not a security boundary: other extensions and Pi
// subagents can act outside this process's tool_call events.

export const permissionCommand = "portals-permission-mode";
export const permissionModes = ["default", "full", "edits", "ask", "plan"] as const;
type PermissionMode = (typeof permissionModes)[number];

interface Context {
  hasUI: boolean;
  ui: { select(title: string, options: string[]): Promise<string | undefined> };
}

interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
  parentToolCallId?: string;
}

interface ExtensionAPI {
  registerCommand(name: string, command: { description: string; handler(args: string): Promise<void> }): void;
  on(event: "tool_call", handler: (event: ToolCall, ctx: Context) => Promise<{ block: true; reason: string } | undefined>): void;
  on(event: "before_agent_start", handler: (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void;
}

const readTools = new Set(["read", "grep", "find", "ls"]);
const modeVariable = "PORTALS_PI_PERMISSION_MODE";

export default function permissions(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  // An unchanged thread keeps Pi's usual behavior. The host sets a chosen mode
  // before sending the next message.
  // A reload keeps the mode in this process only, never in the user's Pi settings.
  const kept = env[modeVariable] ?? "default";
  let mode: PermissionMode = (permissionModes as readonly string[]).includes(kept) ? kept as PermissionMode : "ask";
  pi.registerCommand(permissionCommand, {
    description: "Set this Pi process's Portals permission mode",
    async handler(args) {
      const chosen = args.trim();
      if (!(permissionModes as readonly string[]).includes(chosen)) throw new Error("Unknown Portals permission mode");
      mode = chosen as PermissionMode;
      env[modeVariable] = mode;
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (mode !== "plan") return;
    return { systemPrompt: `${event.systemPrompt}\n\nThis thread is in Plan mode. Read with read, grep, find and ls, then describe your plan. Do not make changes or run commands; wait for the user to change modes.` };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "plan") {
      return readTools.has(event.toolName) ? undefined : { block: true, reason: "Plan mode allows only read, grep, find and ls. Change modes before acting." };
    }
    const asks = event.toolName === "bash" || (mode === "ask" && (event.toolName === "write" || event.toolName === "edit"));
    if (mode === "default" || mode === "full" || !asks) return;
    if (!ctx.hasUI) return { block: true, reason: "Permission was not granted: no question card is available." };
    const choice = await ctx.ui.select(`Allow ${event.toolName}?\n\n${JSON.stringify(event.input)}`, ["Allow once", "Deny"]);
    if (choice !== "Allow once") return { block: true, reason: "Permission was not granted." };
  });
}
