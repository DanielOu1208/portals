import { homedir } from "node:os";
import { join } from "node:path";
import type { Paths } from "../config.ts";
import { ServeLocator } from "../providers/hermes/serve.ts";
import { hermesReadiness, installCommand, modelSetupCommand } from "../providers/hermes/setup.ts";
import { isExecutable, type System } from "./system.ts";
import type { Ui } from "./ui.ts";

// Where setup finds Hermes, or offers to install it, so the bridge serves it as one more
// agent beside Claude Code and Codex (docs/bridge-spikes.md, S5). Installing is Hermes's
// own installer, which ends in Hermes's own setup (a provider and a model); setup only
// offers it, and never starts a `hermes serve` of its own: the bridge does that.

export interface HermesSetup {
  /** `ready`: the bridge will offer Hermes. `not-set-up`: it will, but a turn cannot run yet. `off`: config.json turns it off. */
  state: "ready" | "missing" | "not-set-up" | "off";
  /** One line for setup to show. */
  summary: string;
  /** Settings for config.json's `hermes` section, when there are any to write. */
  config?: Record<string, unknown>;
}

/** The installed `hermes`: on the PATH, else where Hermes's installer puts it. */
function findInstalled(system: System): string | null {
  const installed = join(homedir(), ".local", "bin", "hermes");
  return system.which("hermes") ?? (isExecutable(installed) ? installed : null);
}

/** `enabled`: false when config.json turns Hermes off (`providers.hermes`), which setup leaves as it is. */
export async function setUpHermes(context: { ui: Ui; system: System; interactive: boolean; paths: Paths; enabled: boolean }): Promise<HermesSetup> {
  const { ui, system, interactive, paths } = context;
  let path = findInstalled(system);
  if (!context.enabled) {
    return { state: "off", summary: `Hermes: ${path ? "installed, and " : ""}off on this host (providers.hermes in ${paths.config}).` };
  }
  if (!path) {
    const install =
      interactive &&
      (await ui.confirm("Hermes isn't installed. Install it too? It's Nous Research's open-source agent; its installer asks which AI provider and model to use.", false));
    if (!install) return { state: "missing", summary: `Hermes: not installed. To add it later: ${installCommand}, then run setup again.` };
    const result = await system.run("/bin/bash", ["-c", installCommand], { inherit: true, timeoutMs: 30 * 60_000 });
    path = findInstalled(system);
    if (result.code !== 0 || !path) {
      return { state: "missing", summary: `Hermes: its installer did not finish. Try it yourself (${installCommand}), then run setup again.` };
    }
  }

  const versionRun = await system.run(path, ["--version"], { timeoutMs: 30_000 });
  // "Hermes Agent v0.21.5+5295.g234badf (2026.9.24) · …"
  const version = /v(\d+\.\d+\.\d+)/.exec(versionRun.stdout)?.[1];
  const name = version ? `Hermes ${version}` : "Hermes";
  const config = { path };

  // Only a Hermes that is running can say whether it can run a turn.
  const locator = { path, start: false, cwd: paths.home, logPath: paths.hermesLog };
  if (!(await new ServeLocator(locator).running())) {
    return { state: "ready", summary: `${name}: this host offers it. If Hermes has no AI model set up yet, run: ${modelSetupCommand}`, config };
  }
  const readiness = await ui.task("Asking Hermes whether it can run a turn", () => hermesReadiness(locator));
  if (readiness.ready) {
    const model = readiness.model ? ` with ${readiness.model}${readiness.provider ? ` on ${readiness.provider}` : ""}` : "";
    return { state: "ready", summary: `${name}: ready${model}.`, config };
  }
  return {
    state: "not-set-up",
    summary: `${name}: this host offers it, but it can't run a turn yet (${readiness.problem}). Run ${modelSetupCommand}, then it works in the app.`,
    config,
  };
}
