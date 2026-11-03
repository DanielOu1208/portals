import type { StoredMessage } from "../providers/types.ts";

// What a turn changed, as one diff (feature `turn_diff`): every file the thread's own agent
// edited, wrote, added or deleted in the turn, with the diffs of its edits joined in the
// order they were made, and the lines added and removed, per file and in all.
//
// Built from the turn's tool rows: the diff each edit's row carries is the agent's own
// record of that edit (Claude Code's structured patch, Codex's file changes, Pi's, Droid's
// and Cursor's edits, Hermes's inline diff). Not from `git diff`, which would mix in what
// the user or another agent changed in the folder meanwhile, and says nothing in a folder
// that is not a repository. The same for every agent, live at the turn's end and from the
// agent's own history after a restart of the bridge; where that history would give an
// edit another diff than it had live (Claude Code's, which keeps no structured patch),
// the bridge keeps the live one beside it (src/sessions/keptDiffs.ts).
//
// The edits are joined, not merged: a line an edit changed and a later edit of the same
// turn changed again shows in both, and is counted in both. A file deleted with a shell
// command (`rm`) is not an edit, so it is not here. Subagents' edits are their own.

/** One file the turn changed. */
export interface TurnDiffFile {
  /** As the diffs name it: relative to the thread's folder when inside it, else its absolute path. */
  path: string;
  /** `added`: the turn created it; `deleted`: the turn's last change to it removed it. */
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  /** Its unified diff: one header, then each edit's hunks in order. Empty when the turn's diffs passed the cap before it. */
  diff: string;
  /** Its diff was cut short, or left out: the turn's diffs passed `turnDiffCap`. Its counts are whole. */
  cut?: true;
}

/** What a turn changed. */
export interface TurnDiff {
  /** In the order the turn first changed them. */
  files: TurnDiffFile[];
  added: number;
  removed: number;
  /** One file's diff or more was cut short or left out (`turnDiffCap`). */
  cut?: true;
}

/** How much of a turn's diffs are kept, in characters, about 512 KB: past it a file's diff is cut, and the files after it have none, saying so. */
export const turnDiffCap = 512 * 1024;

/**
 * The line a file's diff cut short by the agent's mapper ends with (`cutDiff`), saying how
 * many lines added and removed were left out: `\ Cut short: +6266 -0 more`. A line that
 * starts with `\` is not a line of the file (as "\ No newline at end of file"), so a
 * diff view leaves it out; the counts here take it in.
 */
const cutLine = /^\\ Cut short: \+(\d+) -(\d+) more/;

/**
 * One file's diff, kept to about `limit` characters: past it, cut at a line's end and ended
 * with a line saying how many lines added and removed were left out, so the turn's counts
 * of it stay whole and the file is said to be cut. A diff within it is left as it is.
 */
export function cutDiff(diff: string, limit: number): string {
  if (diff.length <= limit) return diff;
  const end = diff.lastIndexOf("\n", limit);
  if (end <= 0) return diff.slice(0, limit);
  let added = 0;
  let removed = 0;
  // The file's header is in what is kept: every line after it that starts so is a change.
  for (let at = end + 1; at < diff.length; ) {
    const next = diff.indexOf("\n", at);
    const code = diff.charCodeAt(at);
    if (code === 43) added += 1;
    else if (code === 45) removed += 1;
    at = next === -1 ? diff.length : next + 1;
  }
  return `${diff.slice(0, end + 1)}\\ Cut short: +${added} -${removed} more\n`;
}

/** One file's part of one edit's diff. */
interface Piece {
  /** The name before, or null for a file the edit created (`--- /dev/null`). */
  before: string | null;
  /** The name after, or null for a file the edit deleted (`+++ /dev/null`). */
  after: string | null;
  body: string[];
  added: number;
  removed: number;
  /** Lines added and removed that its diff left out (`cutDiff`), counted in `added` and `removed`. */
  more?: { added: number; removed: number };
}

/** A name from a `---` or `+++` line: without git's `a/` or `b/`, nor a time after a tab; null for `/dev/null`. */
function nameIn(header: string): string | null {
  const path = header.split("\t")[0].trimEnd();
  if (path === "/dev/null" || path === "") return null;
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/** Git's lines between `diff --git` and a file's `---` line, which say nothing shown here. */
const gitHeader = /^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |copy from |copy to )/;

/** The files of one unified diff, each with its lines and counts. Text before any file's header is not placed. */
export function piecesOf(diff: string): Piece[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const out: Piece[] = [];
  let current: Piece | null = null;
  // Lines still to come in the hunk being read, as its header counts them: a removed line
  // that starts with "-- " is not taken for a file's header.
  let oldLeft = 0;
  let newLeft = 0;
  // Where a `--- `, `+++ ` pair cannot be told from lines removed and added (`guessing`:
  // in a hunk whose header gives no numbers, as an apply_patch's chunks, or among lines
  // with no hunk's header at all, as an edit's old and new text alone), it is a file's
  // header only after git's `diff --git` line, which marks where a file starts (Droid's
  // patches have it).
  let guessing = false;
  // Right after a file's header: a pair there is the next file's header when a hunk's
  // header, another file's or the end follows it (a file with no hunk, as a rename alone).
  let fresh = false;
  let afterGitHeader = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inHunk = oldLeft > 0 || newLeft > 0;
    const marked = afterGitHeader;
    afterGitHeader = false;
    const wasFresh = fresh;
    fresh = false;
    const then = lines[index + 2];
    const headerNext = then === undefined || then === "" || then.startsWith("@@") || then.startsWith("--- ");
    if (!inHunk && line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ") && (marked || (wasFresh ? headerNext : !guessing))) {
      guessing = false;
      fresh = true;
      current = { before: nameIn(line.slice(4)), after: nameIn(lines[index + 1].slice(4)), body: [], added: 0, removed: 0 };
      out.push(current);
      index += 1;
      continue;
    }
    if (!inHunk && gitHeader.test(line)) {
      afterGitHeader = true;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      const numbers = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      oldLeft = numbers ? Number(numbers[1] ?? 1) : 0;
      newLeft = numbers ? Number(numbers[2] ?? 1) : 0;
      guessing = !numbers;
      current.body.push(line);
      continue;
    }
    if (!inHunk && !line.startsWith("\\")) guessing = true;
    const more = line.startsWith("\\") ? cutLine.exec(line) : null;
    if (more) {
      // Its diff was cut short: what was left out counts, and its hunk ends here.
      const left = { added: Number(more[1]), removed: Number(more[2]) };
      current.more = { added: (current.more?.added ?? 0) + left.added, removed: (current.more?.removed ?? 0) + left.removed };
      current.added += left.added;
      current.removed += left.removed;
      oldLeft = 0;
      newLeft = 0;
    } else if (line.startsWith("+")) {
      current.added += 1;
      newLeft = Math.max(0, newLeft - 1);
    } else if (line.startsWith("-")) {
      current.removed += 1;
      oldLeft = Math.max(0, oldLeft - 1);
    } else if (!line.startsWith("\\")) {
      oldLeft = Math.max(0, oldLeft - 1);
      newLeft = Math.max(0, newLeft - 1);
    }
    current.body.push(line);
  }
  return out;
}

/** The diff an edit's stored row carries, when the edit was made: none for one denied, failed, or that changed nothing. */
export function editDiffOf(message: StoredMessage): string | undefined {
  if (message.role !== "tool") return undefined;
  const content = message.content;
  // Only a result that names a diff is read as JSON: a command's long output is not.
  if (typeof content === "string" && content.includes('"diff"')) {
    try {
      const result = JSON.parse(content) as Record<string, unknown> | null;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        if (result.status === "blocked" || result.success === false) return undefined;
        if (typeof result.diff === "string" && result.diff !== "") return result.diff;
      }
    } catch {
      // Plain text that happens to say "diff".
    }
  }
  const inline = message.display_metadata?.tool_result_metadata?.inline_diff;
  return typeof inline === "string" && inline !== "" ? unifiedFromInline(inline) : undefined;
}

/**
 * Hermes's inline diff as a unified one: Hermes draws it for a terminal, in colours, under a
 * "review diff" line, with one `a/<path> → b/<path>` line for a file's header (as the app's
 * HermesToolDisplay.unified reads it). A unified diff is left as it is.
 */
export function unifiedFromInline(inline: string): string {
  const plain = inline.includes("\u001b") ? inline.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "") : inline;
  const out: string[] = [];
  for (const line of plain.split("\n")) {
    // Hermes's heading, "  ┊ review diff": not a line of the file that says so.
    if (/^\s*┊\s*review diff\s*$/.test(line)) continue;
    const arrow = line.startsWith("a/") ? line.indexOf(" → ") : -1;
    if (arrow > 0) {
      out.push(`--- ${line.slice(0, arrow)}`, `+++ ${line.slice(arrow + 3)}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/**
 * A piece without line numbers (an edit's old and new text alone, as an agent's history
 * gives it) with the lines its old and new text share at their start and end shown as
 * unchanged, not as removed and added again: an edit that adds a line after one it quoted
 * counts one added, not one removed and two added.
 */
function trimmed(piece: Piece): Piece {
  if (piece.body.some((line) => line.startsWith("@@"))) return piece;
  const body: string[] = [];
  let index = 0;
  while (index < piece.body.length) {
    const removed: string[] = [];
    const added: string[] = [];
    while (index < piece.body.length && piece.body[index].startsWith("-")) removed.push(piece.body[index++].slice(1));
    while (index < piece.body.length && piece.body[index].startsWith("+")) added.push(piece.body[index++].slice(1));
    if (removed.length === 0 && added.length === 0) {
      body.push(piece.body[index++]);
      continue;
    }
    let start = 0;
    while (start < removed.length && start < added.length && removed[start] === added[start]) start += 1;
    let end = 0;
    while (end < removed.length - start && end < added.length - start && removed[removed.length - 1 - end] === added[added.length - 1 - end]) end += 1;
    // One by one: a spread of a long edit's lines passes the engine's limit on arguments.
    for (let at = 0; at < start; at += 1) body.push(` ${removed[at]}`);
    for (let at = start; at < removed.length - end; at += 1) body.push(`-${removed[at]}`);
    for (let at = start; at < added.length - end; at += 1) body.push(`+${added[at]}`);
    for (let at = removed.length - end; at < removed.length; at += 1) body.push(` ${removed[at]}`);
  }
  return {
    ...piece,
    body,
    added: body.filter((line) => line.startsWith("+")).length + (piece.more?.added ?? 0),
    removed: body.filter((line) => line.startsWith("-")).length + (piece.more?.removed ?? 0),
  };
}

/** What `messages`, one turn's, changed; undefined when they changed no file. */
export function turnDiff(messages: readonly StoredMessage[]): TurnDiff | undefined {
  const files = new Map<string, Piece[]>();
  for (const message of messages) {
    const diff = editDiffOf(message);
    if (!diff) continue;
    for (const piece of piecesOf(diff).map(trimmed)) {
      const path = piece.after ?? piece.before;
      if (path === null || (piece.added === 0 && piece.removed === 0 && piece.before !== null && piece.after !== null)) continue;
      const known = files.get(path);
      if (known) known.push(piece);
      else files.set(path, [piece]);
    }
  }
  if (files.size === 0) return undefined;

  const out: TurnDiff = { files: [], added: 0, removed: 0 };
  let room = turnDiffCap;
  for (const [path, pieces] of files) {
    const status = pieces.at(-1)!.after === null ? "deleted" : pieces[0].before === null ? "added" : "modified";
    const lines = [status === "added" ? "--- /dev/null" : `--- a/${path}`, status === "deleted" ? "+++ /dev/null" : `+++ b/${path}`];
    for (const [index, piece] of pieces.entries()) {
      // Edits without line numbers (an edit's old and new text alone) are kept apart.
      if (index > 0 && !piece.body[0]?.startsWith("@@")) lines.push("@@");
      for (const line of piece.body) lines.push(line);
    }
    const file: TurnDiffFile = {
      path,
      status,
      added: pieces.reduce((sum, piece) => sum + piece.added, 0),
      removed: pieces.reduce((sum, piece) => sum + piece.removed, 0),
      diff: "",
    };
    // The agent's record of it was cut short (`cutDiff`): its counts are whole, its diff not.
    if (pieces.some((piece) => piece.more)) {
      file.cut = true;
      out.cut = true;
    }
    const whole = lines.join("\n") + "\n";
    if (whole.length <= room) {
      file.diff = whole;
      room -= whole.length;
    } else {
      // Cut at a line's end, keeping the header and at least a line, else left out.
      const end = whole.lastIndexOf("\n", room);
      const headerEnd = lines[0].length + lines[1].length + 2;
      file.diff = end > headerEnd ? whole.slice(0, end + 1) : "";
      room = 0;
      file.cut = true;
      out.cut = true;
    }
    out.files.push(file);
    out.added += file.added;
    out.removed += file.removed;
  }
  return out;
}

/**
 * Puts on the last message of each turn from `from` on what that turn changed
 * (`turn_diff`), and takes it off the others: a turn is what one user message opens, as
 * the app reads a stored conversation (messages before the first open one of their own).
 * `from` is where a turn starts; `to`, where one still running starts, which has none yet.
 */
export function withTurnDiffs(messages: StoredMessage[], from = 0, to = messages.length): StoredMessage[] {
  let start = from;
  const close = (end: number) => {
    if (end <= start) return;
    const changed = turnDiff(messages.slice(start, end));
    if (changed) messages[end - 1].turn_diff = changed;
  };
  for (let index = from; index < messages.length; index += 1) {
    delete messages[index].turn_diff;
    if (index < to && messages[index].role === "user" && index > start) {
      close(index);
      start = index;
    }
  }
  close(Math.min(to, messages.length));
  return messages;
}
