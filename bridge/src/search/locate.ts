import { realpath, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Where Claude Code and Codex keep a thread's conversation on disk, found without asking
// either (feature thread_search): the search reads the file itself.

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

// MARK: Claude Code

/** The longest folder name Claude Code makes from a path before it shortens it with a hash. */
const claudeNameLimit = 200;

/** Claude Code's folder name for a working folder: every character but a letter or digit a `-`. */
export function claudeFolderName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Claude Code's session file for the thread `id` that ran in `cwd`:
 * `<config>/projects/<folder name>/<id>.jsonl`, where `<config>` is `$CLAUDE_CONFIG_DIR`
 * or `~/.claude`. A path too long for a folder name is cut and ends in a hash of it,
 * which is not worked out here: the folder that starts the same is taken. When neither
 * has it (the folder was moved, or another release names it otherwise), every folder of
 * projects is looked in: the id is the session's own, so a file named by it is it.
 */
export async function claudeSessionFile(id: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!/^[\w-]+$/.test(id)) return null;
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const real = await realpath(cwd).catch(() => cwd);
  const names = [...new Set([claudeFolderName(cwd), claudeFolderName(real)])];
  for (const name of names) {
    if (name.length <= claudeNameLimit && (await isFile(join(projects, name, `${id}.jsonl`)))) return join(projects, name, `${id}.jsonl`);
  }
  const folders = await readdir(projects).catch(() => [] as string[]);
  const cut = names.filter((name) => name.length > claudeNameLimit).map((name) => `${name.slice(0, claudeNameLimit)}-`);
  const likely = folders.filter((folder) => cut.some((start) => folder.startsWith(start)));
  for (const folder of [...likely, ...folders.filter((folder) => !likely.includes(folder))]) {
    const path = join(projects, folder, `${id}.jsonl`);
    if (await isFile(path)) return path;
  }
  return null;
}

/** How long a session file not found is not looked for again: the look goes through every folder the agent keeps. */
const missMs = 60_000;

/**
 * A look for a thread's file, remembered: a file found is checked to be there still, and a
 * thread with none (no message yet, or deleted by its agent) is looked for again only
 * after a minute, not at every search.
 */
export class RememberedFiles {
  private readonly look: (id: string, cwd: string) => Promise<string | null>;
  private readonly now: () => number;
  private readonly known = new Map<string, { path: string | null; at: number }>();

  constructor(look: (id: string, cwd: string) => Promise<string | null>, now: () => number = Date.now) {
    this.look = look;
    this.now = now;
  }

  async find(id: string, cwd: string): Promise<string | null> {
    const known = this.known.get(id);
    if (known?.path && (await isFile(known.path))) return known.path;
    if (known && known.path === null && this.now() - known.at < missMs) return null;
    const path = await this.look(id, cwd);
    this.known.set(id, { path, at: this.now() });
    return path;
  }
}

/** `claudeSessionFile`, remembered: a miss looks through every folder of projects. */
export class ClaudeSessionFiles extends RememberedFiles {
  constructor(env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now) {
    super((id, cwd) => claudeSessionFile(id, cwd, env), now);
  }
}

// MARK: Codex

/** How soon Codex's folders are walked again for an id not found. */
const codexRewalkMs = 10_000;

/**
 * Codex's rollout files by thread id, found by walking `$CODEX_HOME/sessions/YYYY/MM/DD`
 * and `archived_sessions` (`rollout-<when>-<id>.jsonl`) once, and again when an id is not
 * found and the last walk is more than ten seconds old. A file moved since (archived) is
 * found by the next walk.
 */
export class CodexRollouts {
  private readonly home: string;
  private readonly now: () => number;
  private paths = new Map<string, string>();
  private walkedAt = Number.NEGATIVE_INFINITY;
  private walking: Promise<void> | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now) {
    this.home = env.CODEX_HOME || join(homedir(), ".codex");
    this.now = now;
  }

  async find(given: string): Promise<string | null> {
    const id = given.toLowerCase();
    const known = this.paths.get(id);
    if (known && (await isFile(known))) return known;
    if (this.now() - this.walkedAt < codexRewalkMs && !this.walking) return null;
    await (this.walking ??= this.walk().finally(() => (this.walking = null)));
    return this.paths.get(id) ?? null;
  }

  private async walk(): Promise<void> {
    const found = new Map<string, string>();
    const look = async (folder: string, depth: number): Promise<void> => {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && depth > 0) await look(join(folder, entry.name), depth - 1);
        else if (entry.isFile()) {
          const id = rolloutId(entry.name);
          if (id) found.set(id, join(folder, entry.name));
        }
      }
    };
    await look(join(this.home, "sessions"), 3);
    await look(join(this.home, "archived_sessions"), 3);
    this.paths = found;
    this.walkedAt = this.now();
  }
}

/** The thread id a rollout file's name ends with: `rollout-2026-10-26T14-01-02-<uuid>.jsonl`. */
export function rolloutId(name: string): string | null {
  const match = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  return match ? match[1].toLowerCase() : null;
}
