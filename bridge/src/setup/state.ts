import { basename, join } from "node:path";
import { defaultBridgeHome } from "../config.ts";
import { hostOS, logFolder, type HostOS } from "../platform.ts";
import { readJSON, writeJSON } from "../store/jsonFile.ts";
import { label as defaultLabel } from "./launchAgent.ts";

// What setup found and made, in `setup.json` in the bridge's folder, so `pair`, `status`,
// `update` and `uninstall` find the same things later. config.json stays the bridge's.

export interface SetupState {
  /** The service's label: the LaunchAgent's, or on Linux the one its systemd unit is named from (setup/systemd.ts). */
  label: string;
  /** Where the bridge's output is written (by the LaunchAgent, or the systemd unit on Linux). */
  log: string;
  /** The address the phone uses (`https://mac.tailnet.ts.net:10010`), or null when there is none yet. */
  address: string | null;
  /** The `tailscale serve` port setup mapped, which uninstall removes; null when it made none. */
  servePort: number | null;
  /** The machine's name, sent with the pairing link. */
  name: string;
  /** The version setup last installed, and when. */
  version: string;
  updatedAt: string;
}

export function readSetupState(path: string): SetupState | null {
  const data = readJSON<Partial<SetupState> | null>(path, null);
  if (!data || typeof data.label !== "string" || typeof data.log !== "string") return null;
  return {
    label: data.label,
    log: data.log,
    address: typeof data.address === "string" ? data.address : null,
    servePort: typeof data.servePort === "number" ? data.servePort : null,
    name: typeof data.name === "string" ? data.name : "",
    version: typeof data.version === "string" ? data.version : "",
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
  };
}

export function writeSetupState(path: string, state: SetupState): void {
  writeJSON(path, state);
}

/**
 * The label and log for a bridge in `home`: the usual ones in the usual folder; for
 * another folder (`portals-bridge-dev`, say) the label gets the folder's name after a
 * dot and the log is named after the folder, so two bridges never share either.
 * `PORTALS_BRIDGE_LABEL` sets the label.
 */
export function namesFor(home: string, env: NodeJS.ProcessEnv = process.env, os: HostOS = hostOS): { label: string; log: string } {
  const folder = basename(home);
  const log = join(logFolder(os, env), `${folder}.log`);
  const wanted = env.PORTALS_BRIDGE_LABEL?.trim();
  if (wanted) return { label: wanted, log };
  if (home === defaultBridgeHome(os, env)) return { label: defaultLabel, log };
  const suffix = folder.replace(/^portals-bridge-?/, "").replace(/[^A-Za-z0-9-]/g, "-") || "other";
  return { label: `${defaultLabel}.${suffix}`, log };
}
