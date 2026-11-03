import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { RecentFolder } from "../../folders.ts";

// The folders Cursor worked in, for the folders offered to new threads (src/folders.ts),
// read from what Cursor keeps on disk, with no Cursor running:
//
// - `~/.cursor/acp-sessions/<session>/meta.json`: a session made through ACP (this
//   bridge's, another app's), with its folder (`cwd`);
// - `~/.cursor/chats/<md5 of the folder>/<chat>/`: the terminal's chats. The folder is
//   only there as its hash, so it is found among the names in `~/.cursor/projects/`
//   (the folder's path with each `/`, and each other character not a letter or digit,
//   as `-`), each matched to the folders on disk it could be and kept when its hash is
//   a chat folder's.
//
// When is the newest of a folder's sessions or chats. src/folders.ts leaves out what is
// not to be offered (temporary folders, the home folder).

/** How deep a project's name is followed into the disk: deeper paths are rare, and each level reads a folder. */
const deepest = 12;

export async function cursorFolders(home = join(homedir(), ".cursor")): Promise<RecentFolder[]> {
  const newest = new Map<string, number>();
  const note = (path: string, at: number) => {
    if (at > (newest.get(path) ?? 0)) newest.set(path, at);
  };
  await Promise.all([acpSessions(home, note), terminalChats(home, note)]);
  // What apps keep in the Library are their own folders, not projects (a Cursor wrapper's workspaces).
  const library = join(homedir(), "Library") + sep;
  return [...newest]
    .filter(([path]) => !path.startsWith(library))
    .map(([path, lastUsed]) => ({ path, lastUsed }))
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

async function names(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch {
    return [];
  }
}

/** A folder's subfolders, each read once for all of a run's projects: they share the folders near the top. */
type Subfolders = (folder: string) => Promise<string[]>;

function subfolders(): Subfolders {
  const read = new Map<string, Promise<string[]>>();
  return (folder) => {
    let found = read.get(folder);
    if (!found) {
      found = readdir(folder, { withFileTypes: true }).then(
        (entries) => entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name),
        () => [],
      );
      read.set(folder, found);
    }
    return found;
  };
}

async function modified(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function acpSessions(home: string, note: (path: string, at: number) => void): Promise<void> {
  const root = join(home, "acp-sessions");
  for (const session of await names(root)) {
    try {
      const meta = JSON.parse(await readFile(join(root, session, "meta.json"), "utf8")) as { cwd?: unknown };
      if (typeof meta.cwd !== "string" || !meta.cwd.startsWith(sep)) continue;
      note(meta.cwd, (await modified(join(root, session, "store.db"))) || (await modified(join(root, session))));
    } catch {
      // A session being written, or one Cursor keeps otherwise: passed over.
    }
  }
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

async function terminalChats(home: string, note: (path: string, at: number) => void): Promise<void> {
  const hashes = new Set(await names(join(home, "chats")));
  if (hashes.size === 0) return;
  const under = subfolders();
  for (const project of await names(join(home, "projects"))) {
    for (const path of await pathsNamed(project, sep, under)) {
      const hash = md5(path);
      if (!hashes.has(hash)) continue;
      const chats = join(home, "chats", hash);
      let at = 0;
      for (const chat of await names(chats)) at = Math.max(at, await modified(join(chats, chat)));
      note(path, at || (await modified(chats)));
    }
  }
}

/** A path's name as Cursor writes it in `~/.cursor/projects/`: every character not a letter or digit a `-`, without the first. */
export function projectName(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-").replace(/^-/, "");
}

/** The folders on disk whose path Cursor names `project`. */
export async function pathsNamed(project: string, root: string = sep, under: Subfolders = subfolders()): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string, rest: string, depth: number): Promise<void> => {
    if (rest === "") {
      found.push(folder);
      return;
    }
    if (depth >= deepest) return;
    for (const name of await under(folder)) {
      const written = name.replace(/[^A-Za-z0-9]/g, "-");
      if (written === "" || !(rest === written || rest.startsWith(`${written}-`))) continue;
      await walk(join(folder, name), rest.slice(written.length + 1), depth + 1);
    }
  };
  await walk(root, project, 0);
  return found;
}
