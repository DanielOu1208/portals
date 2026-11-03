import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { AgentCommand } from "../types.ts";
import type { DroidHandle } from "./sdk.ts";

export interface DroidCommand extends AgentCommand {
  source: "project" | "user";
  custom: true;
}

interface Template {
  source: DroidCommand["source"];
  prompt: string;
}

function slug(file: string): string {
  return basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function body(text: string): string | null {
  const clean = text.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(clean)) return clean.trim() || null;
  const end = /^---\s*$/gm;
  end.lastIndex = clean.indexOf("\n") + 1;
  const closing = end.exec(clean);
  return closing ? clean.slice(closing.index + closing[0].length).trim() || null : null;
}

function readTemplate(file: string): string | null {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 1_048_576 || realpathSync(file) !== file) return null;
    const named = statSync(file);
    if (named.dev !== opened.dev || named.ino !== opened.ino) return null;
    return body(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

/**
 * What a folder or file was when its commands were read: any change to it reads them
 * again. A folder's `names` too: a file system's clock may tick coarsely (Linux's every
 * few milliseconds, on most kernels), so a file added in the tick the folder was read in
 * leaves its time as it was, and on ext4 its size too.
 */
interface Seen { ino: number; mtimeMs: number; size: number; names?: string }

/** The commands read from one commands folder, with every folder walked and file read in it as they were. */
interface Reading { found: Map<string, Template | null>; seen: Map<string, Seen> }

/** The last reading of each commands folder (a few: the home's and the threads' folders'). */
const readings = new Map<string, Reading>();
const readingsKept = 64;
/** How many times a commands folder was read whole: for tests. */
export let commandReadings = 0;

function seen(path: string): Seen | null {
  try {
    // Not followed: a folder or file swapped for a link is a change.
    const stat = lstatSync(path);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch { return null; }
}

/**
 * Whether nothing in a reading changed: no folder walked had an entry added, removed or
 * renamed (its modification time and its names), and no file read was written or
 * replaced. One lstat each, and a listing for a folder, where reading again opens,
 * checks and reads every file.
 */
function unchanged(reading: Reading): boolean {
  for (const [path, then] of reading.seen) {
    const now = seen(path);
    if (!now || now.ino !== then.ino || now.mtimeMs !== then.mtimeMs || now.size !== then.size) return false;
    if (then.names !== undefined && namesIn(path) !== then.names) return false;
  }
  return true;
}

/** The names in a folder, in one string to compare; null when it cannot be read. */
function namesIn(directory: string): string | null {
  try {
    return readdirSync(directory).sort().join("\0");
  } catch { return null; }
}

/**
 * No symlinks, scripts, arbitrary lookup paths, or ambiguous same-scope slugs. Read again
 * only when something in the commands folder changed (`unchanged`): the list is asked for
 * at every command catalog, slash command and dispatch.
 */
function templates(base: string, source: Template["source"]): Map<string, Template | null> {
  let root: string;
  try {
    root = join(realpathSync(base), ".factory", "commands");
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) return new Map();
  } catch { return new Map(); }
  const key = `${source}\0${root}`;
  const kept = readings.get(key);
  if (kept && unchanged(kept)) {
    readings.delete(key);
    readings.set(key, kept);
    return new Map(kept.found);
  }
  const reading = read(root, source);
  readings.delete(key);
  readings.set(key, reading);
  if (readings.size > readingsKept) readings.delete(readings.keys().next().value!);
  return new Map(reading.found);
}

function read(root: string, source: Template["source"]): Reading {
  commandReadings += 1;
  const found = new Map<string, Template | null>();
  const looked = new Map<string, Seen>();
  const note = (path: string) => {
    const now = seen(path);
    // Gone already: kept as never seen, so the next ask reads again.
    looked.set(path, now ?? { ino: -1, mtimeMs: -1, size: -1 });
  };
  let visited = 0;
  const walk = (directory: string, depth: number): void => {
    if (depth > 12 || visited >= 1024) return;
    // Before reading it, so a change made while it is read is seen next time.
    note(directory);
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    const then = looked.get(directory);
    if (then && then.ino !== -1) then.names = entries.map((entry) => entry.name).sort().join("\0");
    for (const entry of entries) {
      if (++visited > 1024) break;
      if (entry.isSymbolicLink()) continue;
      const file = join(directory, entry.name);
      try {
        // A parent changed to a symlink after discovery is not a reason to read outside.
        if (realpathSync(file) !== file) continue;
        if (entry.isDirectory()) { walk(file, depth + 1); continue; }
        if (!entry.isFile() || extname(entry.name) !== ".md") continue;
        const name = slug(entry.name);
        if (!name) continue;
        if (found.has(name)) { found.set(name, null); continue; }
        note(file);
        const prompt = readTemplate(file);
        found.set(name, prompt ? { source, prompt } : null);
      } catch { /* Missing or unreadable commands are not executable menu entries. */ }
    }
  };
  walk(root, 0);
  return { found, seen: looked };
}

/** Read-only Markdown discovery never starts Droid; warm/cached SDK metadata is optional. */
export function customCommands(
  listed: Awaited<ReturnType<DroidHandle["listCommands"]>>, home: string, cwd?: string,
): DroidCommand[] {
  const available = templates(home, "user");
  if (cwd) for (const [name, template] of templates(cwd, "project")) available.set(name, template);
  const metadata = new Map<string, typeof listed.commands[number]>();
  for (const info of listed.commands) if (!metadata.has(info.name)) metadata.set(info.name, info);
  return [...available].flatMap(([name, template]) => {
    const info = metadata.get(name);
    if (info?.isExecutable || !template) return [];
    return [{ name, description: info?.description ?? `${template.source === "project" ? "Project" : "Personal"} Markdown command`, usage: info?.argumentHint ?? "", skill: false,
      source: template.source, custom: true,
      expand: (args: string) => ({ message: expandCommand(template.prompt, args), display: `/${name}${args ? ` ${args}` : ""}` }) }];
  });
}

export function expandCommand(prompt: string, args: string): string {
  if (prompt.includes("$ARGUMENTS")) return prompt.split("$ARGUMENTS").join(args);
  return args ? `${prompt}\n${args}` : prompt;
}
