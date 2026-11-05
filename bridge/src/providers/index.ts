import { expandHome, type Config, type Paths } from "../config.ts";
import { join } from "node:path";
import { log } from "../log.ts";
import { commandAccess } from "../portals/access.ts";
import { droidProgram } from "../setup/agents.ts";
import { ClaudeProvider } from "./claude/provider.ts";
import { CodexProvider } from "./codex/provider.ts";
import { cursorProgram } from "./cursor/options.ts";
import { CursorProvider } from "./cursor/provider.ts";
import { DroidProvider } from "./droid/provider.ts";
import { FakeProvider } from "./fake.ts";
import { HermesHost } from "./hermes/provider.ts";
import { findHermes } from "./hermes/setup.ts";
import { opencodeProgram } from "./opencode/options.ts";
import { OpenCodeProvider } from "./opencode/provider.ts";
import { PiProvider } from "./pi/provider.ts";
import type { Provider } from "./types.ts";

/** The agents the config turns on, by profile name, in the order the sidebar lists them. */
export function makeProviders(config: Config, paths: Paths): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  // The `portals` command, for the agents whose process the bridge starts.
  const portals = commandAccess(config, paths);
  if (config.providers.claude) {
    const claude = new ClaudeProvider({
      checkpointPath: join(paths.state, "claude-checkpoints.json"),
      settings: { ...config.claude, path: expandHome(config.claude.path), folder: expandHome(config.generalFolder), portals },
    });
    providers.set(claude.profile.name, claude);
  }
  if (config.providers.codex) {
    const codex = new CodexProvider({
      settings: {
        mode: config.codex.mode,
        path: expandHome(config.codex.path),
        socket: config.codex.socket ? expandHome(config.codex.socket) : null,
        imagesDir: paths.images,
        portals,
        titleModel: config.codex.titleModel,
      },
    });
    providers.set(codex.profile.name, codex);
  }
  if (config.providers.pi) {
    const pi = new PiProvider({
      settings: { ...config.pi, path: expandHome(config.pi.path), folder: expandHome(config.generalFolder), portals },
    });
    providers.set(pi.profile.name, pi);
  }
  if (config.providers.cursor) {
    // Only when it is installed: Cursor is offered by default, also by a bridge that was
    // set up before it could run Cursor, and most Macs have none.
    const path = cursorProgram(config.cursor.path);
    if (path) {
      const cursor = new CursorProvider({ command: path, directory: paths.cursor, idleMs: config.cursor.idleMinutes * 60_000, portals });
      providers.set(cursor.profile.name, cursor);
    } else {
      log.info(`Cursor is not installed (no ${config.cursor.path}), so it is not offered`);
    }
  }
  if (config.providers.droid) {
    const path = droidProgram(config.droid.path);
    if (path) {
      const droid = new DroidProvider({
        command: path,
        directory: paths.droid,
        idleMs: config.droid.idleMinutes * 60_000,
        maxWarm: config.droid.maxWarm,
        titleModel: config.droid.titleModel,
        portals,
      });
      providers.set(droid.profile.name, droid);
    } else {
      log.info(`Droid is not installed (no ${config.droid.path}), so it is not offered`);
    }
  }
  if (config.providers.opencode) {
    // Off unless config.json turns it on, which setup does where it finds OpenCode 2.
    const path = opencodeProgram(config.opencode.path);
    if (path) {
      const opencode = new OpenCodeProvider({
        settings: { path, mode: config.opencode.mode, start: config.opencode.start, folder: expandHome(config.generalFolder), logPath: paths.opencodeLog, portals },
      });
      providers.set(opencode.profile.name, opencode);
    } else {
      log.info(`OpenCode is not installed (no ${config.opencode.path}), so it is not offered`);
    }
  }
  if (config.providers.fake) {
    for (let index = 1; index <= config.fake.agents; index += 1) {
      const name = FakeProvider.nameFor(index);
      providers.set(name, new FakeProvider({ directory: paths.fake, delayMs: config.fake.delayMs, name, usage: process.env.PORTALS_FAKE_USAGE === "1" }));
    }
  }
  if (config.providers.hermes) {
    // Only when it is installed: Hermes is offered by default, and most Macs have none.
    const path = findHermes(config.hermes.path);
    if (path) {
      const hermes = new HermesHost({
        settings: { path, start: config.hermes.start, folder: expandHome(config.generalFolder), logPath: paths.hermesLog },
        cachePath: paths.hermesProfiles,
      });
      // One agent per Hermes profile, after the others, whose names it leaves them.
      hermes.addTo(providers);
    } else {
      log.info(`Hermes is not installed (no ${config.hermes.path}), so it is not offered`);
    }
  }
  return providers;
}

/** Starts what the providers run in the background (version checks, connections, idle sweeps). */
export function startProviders(providers: Map<string, Provider>): void {
  for (const provider of providers.values()) provider.start?.();
}
