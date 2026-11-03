import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, sep } from "node:path";
import { expandHome } from "./config.ts";
import { temporaryRoots } from "./folders.ts";
import { cutWhole } from "./json.ts";
import { log } from "./log.ts";
import type { DeskSession, DeskState, Provider } from "./providers/types.ts";
import type { Registry } from "./sessions/registry.ts";

// Sessions started in a terminal at the desk (`desk.list`, docs/gateway-protocol.md,
// section 11): Claude Code's sessions, Codex's threads and Pi's sessions that are not the
// bridge's own, newest first, for the app to take up (`session.adopt`).
//
// Each agent reports its own (providers/*/provider.ts); here the bridge's threads are
// left out, and so are sessions in a folder that is gone, temporary, the bridge's own or
// hidden in config.json. A temporary folder that is the General folder (or under it)
// counts: General always works, and live checks run in one.
//
// The agent's threads taken off the bridge's list (`thread.delete`, removed.json) that
// its own list lacks are offered too, as `closed`: every one of an agent that lists no
// sessions from the desk (Hermes), Claude Code's threads started from a device (its list
// leaves out sessions started through its SDK), and any other an agent leaves out. A
// removed thread is offered with the title it had, also where the agent lists it, as it
// comes back with that title. One that never had a message is not offered: there is
// nothing of it to take up (Claude Code, Codex and Pi keep nothing before the first). Nor
// is one the agent has deleted since (`Provider.keeps`: Claude Code deletes old sessions,
// and a Pi session's file can be deleted at the desk).

/** One session as `desk.list` returns it. */
export interface ListedDeskSession {
  id: string;
  title: string;
  /** The folder it runs in, as its real path. */
  folder: string;
  /** Unix seconds. */
  updated: number;
  state: DeskState;
}

export interface DeskOptions {
  registry: Registry;
  /** The General folder's real path, asked for each time (it can be missing for a while). */
  general: () => string;
  /** config.json's `folders.hide`: never listed, nor anything under them. */
  hide: string[];
  /** The bridge's own folders. */
  own: string[];
  /** Temporary folders; tests give their own. */
  temporary?: string[];
}

/** How many sessions `desk.list` returns when the app does not say. */
export const defaultDeskLimit = 40;
const maximumDeskLimit = 200;
/** The longest title sent; Claude's first prompts can be pages long. */
const titleLength = 120;

export class DeskSessions {
  private readonly options: DeskOptions;

  constructor(options: DeskOptions) {
    this.options = options;
  }

  /** What `desk.list` answers for one agent. */
  async list(provider: Provider, limit = defaultDeskLimit): Promise<ListedDeskSession[]> {
    const wanted = Math.max(1, Math.min(limit, maximumDeskLimit));
    // Some of the newest are the bridge's own or in folders never listed: ask for more.
    let reported: DeskSession[] = [];
    try {
      if (provider.deskSessions) reported = await provider.deskSessions(wanted + this.options.registry.all().length + 20);
    } catch (error) {
      log.warn(`could not list ${provider.profile.displayName}'s sessions from the desk`, { error: (error as Error).message });
      throw new Error(`${provider.profile.displayName} did not say which sessions it has: ${(error as Error).message}`);
    }
    const removed = new Map(
      this.options.registry
        .allRemoved()
        .filter((record) => record.agent === provider.profile.name && (record.preview !== undefined || record.updatedAt > record.createdAt))
        .map((record) => [record.id, record]),
    );
    reported = reported.map((session) => {
      const title = removed.get(session.id)?.title;
      removed.delete(session.id);
      return title ? { ...session, title } : session;
    });
    const offered = [...removed.values()].map((record): DeskSession => ({ id: record.id, title: record.title ?? record.preview ?? "", cwd: record.cwd, updated: record.updatedAt * 1000, state: "closed" }));
    const listed = this.listed();
    const seen = new Set<string>();
    const sessions: ListedDeskSession[] = [];
    for (const session of [...reported, ...offered].sort((a, b) => b.updated - a.updated)) {
      if (seen.has(session.id) || this.options.registry.has(session.id)) continue;
      seen.add(session.id);
      const folder = listed(session.cwd);
      if (!folder) continue;
      // Taken up meanwhile, by another device, it is a thread again.
      if (removed.has(session.id) && (!(await kept(provider, session.id)) || this.options.registry.has(session.id))) continue;
      sessions.push({ id: session.id, title: oneLine(session.title), folder, updated: Math.floor(session.updated / 1000), state: session.state });
      if (sessions.length >= wanted) break;
    }
    return sessions;
  }

  /** Whether a session in `path` is one `list` may offer, as far as its folder goes: `session.adopt` takes up no other. */
  allows(path: string): boolean {
    return this.listed()(path) !== null;
  }

  private listed(): (path: string) => string | null {
    const general = this.options.general();
    const temporary = roots(this.options.temporary ?? [...temporaryRoots, tmpdir()]);
    const never = roots([...this.options.own, ...this.options.hide.map(expandHome)]);
    return (path) => {
      if (typeof path !== "string" || !isAbsolute(path) || !isDirectory(path)) return null;
      const real = realpath(path);
      if (never.some((root) => within(real, root))) return null;
      if (temporary.some((root) => within(real, root)) && !within(real, general)) return null;
      return real;
    };
  }
}

/**
 * Whether the agent still keeps a removed thread its own list lacks: one it has deleted
 * since could never be taken up. Asked only of those about to be offered; one it cannot
 * say about is offered.
 */
async function kept(provider: Provider, id: string): Promise<boolean> {
  try {
    return (await provider.keeps?.(id)) ?? true;
  } catch (error) {
    log.warn(`could not ask ${provider.profile.displayName} whether it still has a removed thread`, { thread: id, error: (error as Error).message });
    return true;
  }
}

/** A title on one line, cut short. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return "Untitled session";
  return line.length > titleLength ? `${cutWhole(line, titleLength - 1).trimEnd()}…` : line;
}

/** Each root as given and as its real path. */
function roots(paths: string[]): string[] {
  return paths.flatMap((root) => {
    const real = isDirectory(root) ? realpath(root) : root;
    return real === root ? [root] : [root, real];
  });
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
