import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeManagedSettings } from "../../platform.ts";

// What Claude Code's settings put in its environment (their `env` key), for a value the
// bridge must know as Claude Code will have it: the token limit of a mentioned file
// (`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, sessions/mentions.ts).
//
// Claude Code 2.1.299 (read from its CLI on 2026-10-26, docs/plans/2026-10-26-file-mentions.md,
// section 3) assigns each source's `env` onto its process environment in turn, so the last
// wins and every one wins over the environment it was started with: the global config
// (`~/.claude.json`), then user (`~/.claude/settings.json`), project
// (`<cwd>/.claude/settings.json`), local (`<cwd>/.claude/settings.local.json`), flag and
// managed (policy) settings. The bridge asks for user, project and local
// (`settingSources`) and passes no flag settings; the global config and managed settings
// always count. `CLAUDE_CONFIG_DIR` moves `~/.claude` and the global config with it.
//
// Not followed: Claude Code reads a worktree's or a subfolder's settings.local.json at
// the repository's main root (its canonical git root) when the user owns it, with the
// cwd's under it; managed settings from MDM or a server; settings changed while a
// session runs (Claude Code takes the limit once per session).

interface Read {
  stamp: string;
  env: Record<string, string> | null;
}

export class ClaudeSettingsEnv {
  private readonly config: string;
  private readonly global: string;
  private readonly managed: string;
  /** Each file's `env` as last read, with what its stat said then: read again once that changes. */
  private readonly files = new Map<string, Read>();

  constructor(env: Record<string, string | undefined>, managed = claudeManagedSettings()) {
    const dir = env.CLAUDE_CONFIG_DIR;
    const home = env.HOME || homedir();
    this.config = dir || join(home, ".claude");
    this.global = dir ? join(dir, ".claude.json") : join(home, ".claude.json");
    this.managed = managed;
  }

  /** The value of `key` Claude Code's settings give a session in `cwd` (none for a folder not known), undefined when none sets it. */
  value(key: string, cwd: string | undefined): string | undefined {
    const sources = [this.global, join(this.config, "settings.json")];
    if (cwd) sources.push(join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"));
    sources.push(this.managed);
    let value: string | undefined;
    for (const file of sources) value = this.envOf(file)?.[key] ?? value;
    return value;
  }

  private envOf(file: string): Record<string, string> | null {
    let stamp: string;
    try {
      const stat = statSync(file);
      stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      this.files.delete(file);
      return null;
    }
    const known = this.files.get(file);
    if (known?.stamp === stamp) return known.env;
    let env: Record<string, string> | null = null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { env?: unknown };
      if (parsed && typeof parsed.env === "object" && parsed.env !== null && !Array.isArray(parsed.env)) {
        env = {};
        // As assigning onto process.env turns them: a number or a flag becomes its text.
        for (const [name, value] of Object.entries(parsed.env)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") env[name] = String(value);
        }
      }
    } catch {
      // One that cannot be read or parsed sets nothing, as in Claude Code.
    }
    // Thread folders come and go; a bridge running for months keeps no more than this.
    if (this.files.size >= 512) this.files.clear();
    this.files.set(file, { stamp, env });
    return env;
  }
}
