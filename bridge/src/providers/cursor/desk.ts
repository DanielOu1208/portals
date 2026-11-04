import { cpSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { log } from "../../log.ts";
import { Transcript } from "../../sessions/transcript.ts";
import type { SessionUpdate } from "../acp/protocol.ts";
import { AcpStream } from "../acp/stream.ts";
import { titleFrom } from "../titles.ts";
import type { StoredMessage } from "../types.ts";
import { cursorQuirks } from "./options.ts";
import { cursorTools } from "./tools.ts";

// The chats of Cursor's terminal (`cursor-agent`, `cursor-agent -p`), as the desk's list
// offers them (`desk.list`, docs/gateway-protocol.md, section 11), and what a fork of one
// is made from.
//
// Cursor keeps each in `~/.cursor/chats/<md5 of its folder>/<chat>/`: a `meta.json` with
// its folder (`cwd`), title, whether it has a conversation and whether it is a subagent's,
// and the conversation in a SQLite store, `store.db`. Its ACP opens none of them: it opens
// only the sessions in `~/.cursor/acp-sessions/<session>/`, a folder of the same kind. A
// copy of a chat's folder there, under a new id, is one it opens and goes on from (seen
// with 2026.10.22). So a chat is taken up as a fork alone: the chat stays the terminal's.
//
// The bridge cannot read the store's conversation itself. Cursor sends it again as it
// opens the copy (`session/load`), and that is what the fork's thread shows (`replayed`).

/** A chat of Cursor's terminal, as its `meta.json` says. */
export interface TerminalChat {
  /** Cursor's id for it: the name of its folder. */
  id: string;
  /** Its folder, with `meta.json` and the store. */
  folder: string;
  /** The folder it ran in. */
  cwd: string;
  title: string | null;
  /** When it last changed, in milliseconds since 1970. */
  updated: number;
}

async function names(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch {
    return [];
  }
}

/** What a chat's `meta.json` says; null for one with no conversation, a subagent's, or one that does not say its folder (Cursor before it wrote it). */
async function readChat(folder: string, id: string): Promise<TerminalChat | null> {
  try {
    const meta = JSON.parse(await readFile(join(folder, "meta.json"), "utf8")) as { cwd?: unknown; title?: unknown; hasConversation?: unknown; isSubagent?: unknown; updatedAtMs?: unknown };
    if (meta.hasConversation !== true || meta.isSubagent === true) return null;
    if (typeof meta.cwd !== "string" || !meta.cwd.startsWith(sep)) return null;
    const title = typeof meta.title === "string" && meta.title.trim() !== "" ? meta.title.trim() : null;
    return { id, folder, cwd: meta.cwd, title, updated: typeof meta.updatedAtMs === "number" ? meta.updatedAtMs : 0 };
  } catch {
    // A chat being written, or one Cursor keeps otherwise: passed over.
    return null;
  }
}

/** The terminal's chats with a conversation, newest first. */
export async function terminalChats(home: string): Promise<TerminalChat[]> {
  const root = join(home, "chats");
  const found: TerminalChat[] = [];
  for (const hash of await names(root)) {
    for (const id of await names(join(root, hash))) {
      const chat = await readChat(join(root, hash, id), id);
      if (chat) found.push(chat);
    }
  }
  return found.sort((a, b) => b.updated - a.updated);
}

/** The terminal's chat `id`; null when Cursor has none by that id. `id` is a bare name, checked by the caller. */
export async function terminalChat(home: string, id: string): Promise<TerminalChat | null> {
  const root = join(home, "chats");
  for (const hash of await names(root)) {
    if ((await names(join(root, hash))).includes(id)) return readChat(join(root, hash, id), id);
  }
  return null;
}

/** A chat's store, and the files SQLite keeps beside it while the store is open. */
const storeFile = /^store\.db(?:-wal|-shm|-journal)?$/;

/**
 * Copies a terminal chat's folder to `to`, which is new. The terminal may be writing the
 * chat's store as it is copied, and Cursor keeps it in SQLite's write-ahead log mode:
 * copied file by file, the store and its log could be from different moments, and the
 * copy malformed or without what was only in the log. So the store is copied by SQLite's
 * own backup, as one moment of it with its log, and the files beside it are not copied.
 * Its connection only reads, and waits for a writer as long as Cursor's own do.
 */
export async function copyChat(from: string, to: string): Promise<void> {
  cpSync(from, to, { recursive: true, filter: (source) => !storeFile.test(relative(from, source)) });
  const store = join(from, "store.db");
  if (!(await names(from)).includes("store.db")) return;
  // Loaded only here: Node says once that its SQLite is experimental.
  const { DatabaseSync, backup } = await import("node:sqlite");
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    await backup(db, join(to, "store.db"));
  } finally {
    db.close();
  }
}

/**
 * Whether Cursor keeps Run Everything in the session whose store is `store`: it does for
 * a chat run with `--force`, or once Run Everything was chosen in it, and then searches
 * the web and fetches pages for it without asking, wherever the session is opened (the
 * store's metadata, one row of JSON written as hex, `isRunEverything`; seen with
 * 2026.10.22). False when the store cannot be read.
 */
export async function keepsRunEverything(store: string): Promise<boolean> {
  try {
    // Loaded only here: Node says once that its SQLite is experimental.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(store, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT value FROM meta").all()) {
        const value = typeof row.value === "string" ? row.value : "";
        const text = /^[0-9a-f]+$/i.test(value) ? Buffer.from(value, "hex").toString("utf8") : value;
        try {
          if ((JSON.parse(text) as { isRunEverything?: unknown })?.isRunEverything === true) return true;
        } catch {
          // A row of another kind.
        }
      }
      return false;
    } finally {
      db.close();
    }
  } catch (error) {
    log.debug("could not read a Cursor chat's store", { error: (error as Error).message });
    return false;
  }
}

/**
 * A conversation as Cursor sends it again when it opens a session (`session/load`), in
 * the shape the app is shown: each message of the user's opens a turn, and what Cursor
 * said and did after it, up to the next, is that turn's. The title is the one Cursor
 * gives it there, else the first message's first line.
 */
export function replayed(updates: SessionUpdate[], cwd: string): { messages: StoredMessage[]; title: string | null } {
  const transcript = new Transcript();
  const stream = new AcpStream({ cwd, quirks: { ...cursorQuirks, own: cursorTools(new Map()) } });
  let said = "";
  let title: string | null = null;
  let first: string | null = null;
  let open = false;
  const close = () => {
    if (!open) return;
    for (const event of stream.endTurn()) transcript.apply(event);
    transcript.apply({ type: "turn.end", status: "complete" });
    open = false;
  };
  // A message of the user's may come in pieces: it opens its turn once something else comes.
  const opened = () => {
    if (said === "") return;
    close();
    transcript.startTurn(said);
    first ??= said;
    open = true;
    said = "";
  };
  for (const update of updates) {
    if (update.sessionUpdate === "user_message_chunk") {
      if (update.content?.type === "text" && typeof update.content.text === "string") said += update.content.text;
      continue;
    }
    opened();
    if (update.sessionUpdate === "session_info_update") {
      if (typeof update.title === "string" && update.title.trim() !== "") title = update.title.trim();
      continue;
    }
    // Before the first message of the user's there is no turn to put it in.
    if (!open) continue;
    for (const event of stream.map(update)) transcript.apply(event);
  }
  opened();
  close();
  return { messages: transcript.messages, title: title ?? (first === null ? null : titleFrom(first)) };
}
