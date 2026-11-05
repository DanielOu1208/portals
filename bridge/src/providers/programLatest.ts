import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { readJSON, writeJSON } from "../store/jsonFile.ts";

// The latest release of each agent's program (feature agent_programs): read from where
// that program's own updater looks, at most every eight hours, across restarts too
// (`state/programs.json` says when), and only as someone looks at the list, so a host
// nobody asks asks nobody. What cannot be found is simply not said. `updates.check` false
// in config.json: it never asks, as for portals-host's own version (src/updates.ts).

/** Where a program's latest release is said. */
export type LatestSource =
  /** A dist-tag of an npm package. */
  | { kind: "npm"; package: string; tag(env: NodeJS.ProcessEnv): string }
  /** A page that names the release in its text: Cursor's install script. */
  | { kind: "page"; url: string; pattern: RegExp }
  /** The latest release of a repository on GitHub, whose tag is the version with a v before it. */
  | { kind: "github"; repository: string };

/** How often the sources are asked: a few times a day. */
export const latestEveryMs = 8 * 60 * 60 * 1000;

/** How long an answer is believed when no newer one could be had: past this it may no longer be the latest. */
const latestStandsMs = 3 * 24 * 60 * 60 * 1000;

const answerMs = 15_000;

/** More than any of these answers weighs: a larger one is not read. */
const mostBytes = 1024 * 1024;

const release = /^\d+\.\d+\.\d+/;

/** The dist-tags of an npm package: a small answer, without the package's whole description. */
function distTags(name: string): string {
  return `https://registry.npmjs.org/-/package/${name}/dist-tags`;
}

/**
 * Which of npm's tags `claude update` follows: Claude Code's `autoUpdatesChannel`, whose
 * `stable` is about a week behind `latest`, in the settings it reads.
 */
export function claudeChannel(env: NodeJS.ProcessEnv, home: string): string {
  const folder = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  try {
    return (JSON.parse(readFileSync(join(folder, "settings.json"), "utf8")) as { autoUpdatesChannel?: unknown } | null)?.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
}

interface Kept {
  checked?: unknown;
  latest?: unknown;
}

interface Named {
  version: string;
  /** When it was said, in milliseconds since 1970. */
  at: number;
}

export interface LatestOptions {
  /** `state/programs.json`. */
  file: string;
  /** False: nothing is asked (`updates.check`). */
  check: boolean;
  env?: NodeJS.ProcessEnv;
  everyMs?: number;
  answerMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

export class LatestReleases {
  private readonly options: LatestOptions;
  private readonly now: () => number;
  private readonly named = new Map<string, Named>();
  private checked = 0;
  private asking: Promise<void> | undefined;

  constructor(options: LatestOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    const kept = readJSON<Kept | null>(options.file, {}) ?? {};
    const when = typeof kept.checked === "string" ? Date.parse(kept.checked) : Number.NaN;
    if (Number.isFinite(when)) this.checked = when;
    if (kept.latest && typeof kept.latest === "object") {
      for (const [id, entry] of Object.entries(kept.latest as Record<string, Partial<Named>>)) {
        if (typeof entry?.version === "string" && release.test(entry.version) && typeof entry.at === "number") this.named.set(id, { version: entry.version, at: entry.at });
      }
    }
  }

  /** The latest release of `id` as last heard, unless that was too long ago to hold. */
  version(id: string): string | undefined {
    const named = this.named.get(id);
    return named && this.now() - named.at < latestStandsMs ? named.version : undefined;
  }

  /** The asking under way, if any (tests wait for it). */
  get settled(): Promise<void> {
    return this.asking ?? Promise.resolve();
  }

  /**
   * Asks each source when the last round was long enough ago, and returns at once: the
   * answers are for the next look. A clock set back counts as a round made now.
   */
  askIfDue(sources: Map<string, LatestSource>): void {
    if (!this.options.check || this.asking || sources.size === 0) return;
    const since = this.now() - this.checked;
    if (since >= 0 && since < (this.options.everyMs ?? latestEveryMs)) return;
    this.checked = this.now();
    // Kept before asking: a host that stops while it asks, again and again, still asks only so often.
    this.keep();
    this.asking = Promise.all([...sources].map(async ([id, source]) => {
      const version = await this.ask(source);
      if (version !== undefined) this.named.set(id, { version, at: this.now() });
    })).then(() => {
      this.keep();
      this.asking = undefined;
    });
  }

  private async ask(source: LatestSource): Promise<string | undefined> {
    const url = source.kind === "npm" ? distTags(source.package) : source.kind === "page" ? source.url : `https://api.github.com/repos/${source.repository}/releases/latest`;
    try {
      const headers: Record<string, string> = source.kind === "github" ? { Accept: "application/vnd.github+json", "User-Agent": "portals-host" } : {};
      const response = await (this.options.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(this.options.answerMs ?? answerMs) });
      if (!response.ok) throw new Error(`it answered ${response.status}`);
      if (Number(response.headers.get("content-length") ?? 0) > mostBytes) throw new Error("its answer is too large");
      const text = await response.text();
      if (text.length > mostBytes) throw new Error("its answer is too large");
      const said = source.kind === "page"
        ? source.pattern.exec(text)?.[1]
        : source.kind === "npm"
          ? (JSON.parse(text) as Record<string, unknown>)[source.tag(this.options.env ?? process.env)]
          : (JSON.parse(text) as { tag_name?: unknown }).tag_name;
      if (typeof said !== "string") throw new Error("it named no release");
      const version = said.replace(/^v/, "");
      if (!release.test(version)) throw new Error("what it named is not a release");
      return version;
    } catch (error) {
      log.debug("could not find an agent's latest release", { url, error: (error as Error)?.message ?? String(error) });
      return undefined;
    }
  }

  private keep(): void {
    try {
      writeJSON(this.options.file, { checked: new Date(this.checked).toISOString(), latest: Object.fromEntries(this.named) });
    } catch (error) {
      log.debug("could not keep the agents' latest releases", { error: (error as Error).message });
    }
  }
}
