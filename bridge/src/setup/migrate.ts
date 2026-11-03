import { existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LaunchAgent, oldLabel } from "./launchAgent.ts";
import type { System } from "./system.ts";

// Moving a bridge set up before the app was called Portals (`aeriportal-bridge`, label
// `com.danielou.aeriportal.bridge`) to the new names: its folder, with its threads,
// settings and password, and then its LaunchAgent, which setup installs again under the
// new label. The port and the `tailscale serve` mapping stay as they are, so the phone
// keeps reaching it at the same address with the same password.

export function oldBridgeHome(): string {
  return join(homedir(), "Library", "Application Support", "aeriportal-bridge");
}

/** An old install to move into `home`: there is one, and nothing is in `home` yet. */
export function oldInstallToMove(oldHome: string, home: string): boolean {
  return existsSync(join(oldHome, "config.json")) && !existsSync(home);
}

export interface MoveResult {
  /** The old LaunchAgent was running and has been stopped. */
  stopped: boolean;
}

/**
 * Stops the old LaunchAgent, moves `oldHome` to `home` and removes the old plist. The
 * new LaunchAgent is setup's next step. If the folder cannot be moved, the old
 * LaunchAgent is started again and nothing has changed.
 */
export async function moveOldInstall(system: System, oldHome: string, home: string, options: { plistFolder?: string } = {}): Promise<MoveResult> {
  const old = new LaunchAgent(system, oldLabel, options.plistFolder);
  const { loaded, unknown } = await old.state();
  if (unknown) throw new Error(unknown);
  if (loaded) await old.stop();
  try {
    renameSync(oldHome, home);
  } catch (error) {
    if (loaded && existsSync(old.file)) await old.start();
    throw error;
  }
  // The old copy of the code goes with it; setup installs the new one over it.
  rmSync(old.file, { force: true });
  return { stopped: loaded };
}
