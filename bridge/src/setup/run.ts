import { parseArgs } from "node:util";
import { readManifest } from "./install.ts";
import { pair, relayReset, setup, status, telemetry, uninstall, update, type ClaudeMode, type Context } from "./commands.ts";
import { realSystem } from "./system.ts";
import { Cancelled, ClackUi, TerminalUi } from "./ui.ts";

// Reads the command line and runs the command (cli.ts is the entry).

export async function run(argv: string[], usage: string): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        yes: { type: "boolean", short: "y" },
        claude: { type: "string" },
        "no-tailscale": { type: "boolean" },
        address: { type: "string" },
        port: { type: "string" },
        "no-service": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    console.log(readManifest().version);
    return 0;
  }
  const command = positionals[0];
  if (values.help || !command) {
    console.log(usage);
    return command || values.help ? 0 : 2;
  }

  const interactive = !values.yes && Boolean(process.stdin.isTTY);
  // Someone at a terminal gets the guided flow; `--yes`, a script or a log gets plain lines.
  const ui = interactive ? new ClackUi() : new TerminalUi({ interactive });
  const context: Context = { ui, system: realSystem, env: process.env, interactive };
  const code = await runCommand(positionals, values, context, usage);
  if (ui instanceof ClackUi) ui.close(code);
  return code;
}

async function runCommand(positionals: string[], values: Record<string, string | boolean | undefined>, context: Context, usage: string): Promise<number> {
  const command = positionals[0];
  try {
    switch (command) {
      case "setup": {
        const claude = values.claude as ClaudeMode | undefined;
        if (claude !== undefined && !["api-key", "login", "off"].includes(claude)) {
          console.error("--claude takes api-key, login or off.");
          return 2;
        }
        const port = values.port === undefined ? undefined : Number(values.port);
        if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
          console.error("--port takes a port number.");
          return 2;
        }
        return await setup(
          { service: !values["no-service"], tailscale: !values["no-tailscale"], address: values.address as string | undefined, port, claude },
          context,
        );
      }
      case "pair":
        return await pair(context);
      case "status":
        return await status(context);
      case "update":
        return await update(context);
      case "relay":
        if (positionals[1] !== "reset") {
          console.error(`portals-host relay takes reset.\n\n${usage}`);
          return 2;
        }
        return await relayReset(context);
      case "telemetry": {
        const action = positionals[1] ?? "status";
        if (action !== "on" && action !== "off" && action !== "status") {
          console.error(`portals-host telemetry takes on, off or status.\n\n${usage}`);
          return 2;
        }
        return await telemetry(action, context);
      }
      case "uninstall":
        return await uninstall(context);
      default:
        console.error(`There is no command ${command}.\n\n${usage}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof Cancelled || (error as Error).message === "cancelled") return 130;
    context.ui.warn(`Something went wrong: ${(error as Error).message}`);
    return 1;
  }
}
