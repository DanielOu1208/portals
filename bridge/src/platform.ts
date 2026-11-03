import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// What differs between the two systems the bridge runs on, macOS and Linux
// (docs/linux-plan.md), in one place. On a Mac every answer is what it was before the
// bridge ran on Linux. Each takes the system as an argument, so that the tests on either
// one can ask for the other's answers too.

export type HostOS = "macos" | "linux";

/** The system this bridge runs on. Anything but macOS is taken for Linux, the only other one setup knows. */
export const hostOS: HostOS = process.platform === "darwin" ? "macos" : "linux";

/**
 * What the bridge calls the machine it runs on in what it tells the person and the
 * agents: "Mac", or "Linux computer" (2026-10-28: "Linux computer is ok for now").
 */
export function machineWord(os: HostOS = hostOS): string {
  return os === "macos" ? "Mac" : "Linux computer";
}

/** The folder the bridge's own folder goes in: Application Support on a Mac, XDG's data folder on Linux. */
export function dataFolder(os: HostOS = hostOS, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (os === "macos") return join(home, "Library", "Application Support");
  return xdgFolder(env.XDG_DATA_HOME) ?? join(home, ".local", "share");
}

/** The folder setup has the bridge's log written in: ~/Library/Logs on a Mac, XDG's state folder on Linux. */
export function logFolder(os: HostOS = hostOS, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (os === "macos") return join(home, "Library", "Logs");
  return xdgFolder(env.XDG_STATE_HOME) ?? join(home, ".local", "state");
}

/** An XDG folder from the environment. The XDG spec ignores one that is not an absolute path, and so does this. */
function xdgFolder(value: string | undefined): string | undefined {
  const path = value?.trim();
  return path && isAbsolute(path) ? path : undefined;
}

/** Claude Code's managed (policy) settings, where Claude Code reads them on each system. */
export function claudeManagedSettings(os: HostOS = hostOS): string {
  return os === "macos" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json";
}

/**
 * The usual folders of programs, for the PATH of a bridge that a service manager starts
 * without a terminal's PATH (after the folders of the agents and of node): where the
 * agents' installers, Homebrew (Linuxbrew on Linux), npm and the system put them.
 */
export function programFolders(os: HostOS = hostOS, home = homedir()): string[] {
  const local = join(home, ".local", "bin");
  if (os === "macos") return [local, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [local, "/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin", "/snap/bin"];
}

/**
 * The machine's name as people know it, or "" when it has none of its own besides its
 * host name: a Mac's Computer Name ("a Mac mini", System Settings > General >
 * Sharing), or on Linux the pretty host name systemd keeps in /etc/machine-info
 * (`hostnamectl set-hostname --pretty`), which most machines leave unset.
 */
export function computerName(os: HostOS = hostOS): string {
  if (os === "macos") {
    try {
      return execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  }
  try {
    return prettyHostname(readFileSync("/etc/machine-info", "utf8"));
  } catch {
    return "";
  }
}

/**
 * `PRETTY_HOSTNAME` from the text of /etc/machine-info, an environment file: `KEY=value`
 * lines, the value maybe in single quotes or in double quotes with backslash escapes, the
 * last of a key counting. "" when it is not set.
 */
export function prettyHostname(text: string): string {
  let found = "";
  for (const line of text.split("\n")) {
    const match = /^\s*PRETTY_HOSTNAME\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[1];
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(.)/g, "$1");
    }
    found = value.trim();
  }
  return found;
}
