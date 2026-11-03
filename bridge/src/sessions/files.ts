import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { cutWhole } from "../json.ts";

// Files a person attaches to a message (feature `files`). Each is saved in the thread's
// folder, under `.portals/files/<thread>/`, where every agent can read it without asking
// for a folder of its own, and the message names it by its path under one line that opens
// the list. That line is what the agent reads, what the agent's own history keeps, and
// what the app finds again to show the files as files (HermesHistoryMapper).

/** The line before the paths of a message's files. Fixed: the app reads messages by it. */
export const filesHeading = "Files attached in Portals (saved on this Mac):";

/** The largest file the bridge takes, and how many may go with one message. */
export const fileLimit = 25 * 1024 * 1024;
export const filesPerMessage = 10;

/** The folder in a thread's folder that the bridge keeps its own things in; git leaves it out. */
const portalsFolder = ".portals";

/** `text` as the agent is sent it: with the list of files after it, when there are any. */
export function withFiles(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const list = [filesHeading, ...paths.map((path) => `- ${path}`)].join("\n");
  return text.trim() === "" ? list : `${text}\n\n${list}`;
}

/** A message as sent, split into what the person wrote and the paths of its files. */
export function splitFiles(text: string): { text: string; paths: string[] } {
  const lines = text.split("\n");
  const at = lines.lastIndexOf(filesHeading);
  if (at === -1) return { text, paths: [] };
  const rest = lines.slice(at + 1);
  // Only a list that runs to the end of the message, a path a line, is one of the bridge's.
  if (rest.length === 0 || !rest.every((line) => line.startsWith("- ") && line.length > 2)) return { text, paths: [] };
  return { text: lines.slice(0, at).join("\n").replace(/\n+$/, ""), paths: rest.map((line) => line.slice(2)) };
}

/** A file name to save under: no folders, nothing hidden, no characters a shell or the Finder trips on. */
export function safeFileName(name: string): string {
  const cleaned = basename(name)
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  return cleaned === "" ? "file" : cutWhole(cleaned, 120);
}

/** Where a thread's attached files are kept, in its folder. */
export function filesFolder(cwd: string, thread: string): string {
  return join(cwd, portalsFolder, "files", thread.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/**
 * Saves a file attached to a thread's next message, and returns its path. A name taken
 * already gets " 2", " 3", … before its extension: a file is never written over.
 */
export async function saveAttachment(cwd: string, thread: string, name: string, data: Buffer): Promise<string> {
  const folder = filesFolder(cwd, thread);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  // Each folder below the thread's own is the bridge's, made here: a link in its place
  // (a repository can hold one) would take the files somewhere else.
  const portals = join(cwd, portalsFolder);
  for (const path of [portals, join(portals, "files"), folder]) await ownFolder(path);
  // Everything in the bridge's folder is left out of git, this line included. Never
  // written over, nor through a link. The files have a line of their own as well, in the
  // folder only the bridge writes in: a .gitignore there already in .portals may say
  // something else.
  await writeFile(join(portals, ".gitignore"), "*\n", { flag: "wx" }).catch(() => undefined);
  await ignoreAll(join(portals, "files", ".gitignore"));
  // And the thread's folder one of its own, deepest, which no rule above it can undo.
  if (!(await ignoreAll(join(folder, ".gitignore")))) throw new Error("its folder cannot be kept out of git.");
  const safe = safeFileName(name);
  const extension = extname(safe);
  const stem = safe.slice(0, safe.length - extension.length) || "file";
  for (let copy = 1; copy < 1000; copy += 1) {
    const path = join(folder, copy === 1 ? safe : `${stem} ${copy}${extension}`);
    try {
      await writeFile(path, data, { flag: "wx", mode: 0o600 });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const path = join(folder, `${stem} ${randomUUID().slice(0, 8)}${extension}`);
  await writeFile(path, data, { flag: "wx", mode: 0o600 });
  return path;
}

/**
 * A .gitignore that leaves everything beside it out of git: made, or given the line it
 * lacks, last, where no rule before it can undo it. False when it cannot be: a link, or
 * not a file.
 */
async function ignoreAll(path: string): Promise<boolean> {
  const made = await writeFile(path, "*\n", { flag: "wx" }).then(() => true, () => false);
  if (made) return true;
  const stats = await lstat(path).catch(() => undefined);
  // Never through a link.
  if (!stats?.isFile()) return false;
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line !== "");
  if (lines.at(-1) === "*") return true;
  await appendFile(path, `${text === "" || text.endsWith("\n") ? "" : "\n"}*\n`);
  return true;
}

/** Makes the folder `path`, or finds it there already: a folder, and not a link to one. */
async function ownFolder(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await lstat(path)).isDirectory()) throw new Error(`${path} is not a folder of its own: it may be a link to another.`);
}
