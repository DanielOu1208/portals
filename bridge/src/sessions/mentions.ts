import { realpathSync, statSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, sep } from "node:path";

// Files a person mentions in a message (feature file_mentions): picked from the menu
// `files.search` fills when they type `@`, sent with `prompt.submit` as `mentions`, paths
// relative to the thread's folder. The message's text is the truth: each mention is in it
// as `@path` (`@"path"` when it has a space), as Claude Code's own prompt writes one, and
// one the app left out of the text is put at its end. What each agent does with it
// (docs/plans/2026-10-26-file-mentions.md, section 3):
//
// - Claude Code reads every `@path` of a message itself, before the model sees it, and
//   gives the model the file, up to a limit (`claudeMentionLimit`): a larger one it leaves
//   out, telling its model only when the file is over 256 KiB. The app says so beside a
//   mention (`mention_limit`, `size`, `large_mentions`).
// - Codex's `mention` input is for apps, plugins and skills (`app://…`, `plugin://…`,
//   `skill://…`), not files; its own composer puts a file picked with `@` into the text as
//   its path. So the text alone, as there.
// - Cursor, spoken to over ACP, is given a `resource_link` per file besides the text: what
//   the protocol has for "the person points at this file", which every ACP agent takes.
// - Pi, Droid and Hermes: the text alone. Their models read a path named in the text.
//
// The bridge never puts a file's contents into the message.

/** The most mentions a message keeps; the rest are left out. */
export const mentionsPerMessage = 20;

/**
 * The mentions of a message that name something in the thread's folder (a file or a
 * folder, links resolved), as given, in order and each once. One absolute, with `..`
 * out of the folder, a `"` or a line break, or naming nothing, is left out. A thread with
 * no folder (`cwd` undefined) keeps none.
 */
export function checkMentions(cwd: string | undefined, mentions: readonly string[]): string[] {
  if (!cwd || !isAbsolute(cwd)) return [];
  let folder: string;
  try {
    folder = realpathSync(cwd);
  } catch {
    return [];
  }
  const kept: string[] = [];
  for (const mention of mentions) {
    if (kept.length >= mentionsPerMessage) break;
    if (typeof mention !== "string" || mention === "" || /["\0\r\n]/.test(mention) || isAbsolute(mention)) continue;
    // A `\` is part of a name on a Mac (a\b.txt is one file), not a separator.
    const path = posix.normalize(mention).replace(/\/$/, "");
    if (path === "." || path === ".." || path.startsWith("../") || kept.includes(path)) continue;
    try {
      const real = realpathSync(resolve(folder, path));
      if (real !== folder && !real.startsWith(folder.endsWith(sep) ? folder : folder + sep)) continue;
      statSync(real);
    } catch {
      continue;
    }
    kept.push(path);
  }
  return kept;
}

/** Characters Claude Code reads a word's `@` after, besides white space (CJK punctuation). */
const beforeMention = "\u3002\u3001\uFF1F\uFF01";

/** Whether a character is one Claude Code ends a `@path` on: a letter, a digit or `_`, of ASCII. */
function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /^[0-9A-Za-z_]$/.test(char);
}

/**
 * How a mention is written in a message: `@path`, or `@"path"` when Claude Code would
 * read the bare one otherwise: a path with white space, or one that does not end on a
 * letter, digit or `_` (Claude Code drops what follows the last of those, so `@notes.md,`
 * reads as notes.md, and `@café` as caf).
 */
export function mentionToken(path: string): string {
  return /\s/.test(path) || !isWordCharacter(path[path.length - 1]) ? `@"${path}"` : `@${path}`;
}

/**
 * The paths a message's text mentions as Claude Code reads them (its own prompt's rule,
 * read from the CLI the bridge runs, @anthropic-ai/claude-agent-sdk 0.3.292, on 2026-10-26):
 * `@"path"` after the start or white space; and in each word, an `@` at its start (or
 * after CJK punctuation), up to the word's last ASCII letter, digit or `_`. So
 * `(@a.ts)` mentions nothing, and `@note?copy` mentions note?copy, not note.
 */
export function mentionedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp(`(^|[\\s${beforeMention}])@"([^"]+)"`, "g"))) found.add(match[2]);
  for (const [word] of text.matchAll(/\S+/g)) {
    let at = word.indexOf("@");
    while (at > 0 && !beforeMention.includes(word[at - 1])) at = word.indexOf("@", at + 1);
    if (at === -1) continue;
    let end = word.length;
    while (end >= at + 2 && isWordCharacter(word[end - 1]) === isWordCharacter(word[end])) end -= 1;
    if (end < at + 2) continue;
    const path = word.slice(at + 1, end);
    if (!path.startsWith('"')) found.add(path);
  }
  return [...found];
}

/**
 * `text` with each mention's token at its end that Claude Code would not read in it
 * already, a space before each. The app's composer opens its menu only at the start of a
 * word and writes the token there (2026-10-26, as Claude Code reads one), so a
 * mention right after punctuation, `(@a.ts)`, does not come from it: this is the safety
 * net for a mention sent whose token the text lacks as Claude Code reads it (the person
 * edited it after picking the file, or another app wrote it elsewhere).
 */
export function withMentions(text: string, mentions: readonly string[]): string {
  if (mentions.length === 0) return text;
  // An unfinished quoted token can consume an appended quote. Only that case
  // needs the complete text parsed again before each explicit mention.
  const unfinishedQuote = new RegExp(`(^|[\\s${beforeMention}])@"[^"]*$`).test(text);
  const present = unfinishedQuote ? undefined : new Set(mentionedPaths(text));
  let written = text;
  for (const mention of mentions) {
    const found = present ?? new Set(mentionedPaths(written));
    if (found.has(mention)) continue;
    const token = mentionToken(mention);
    written = written === "" || /\s$/.test(written) ? `${written}${token}` : `${written} ${token}`;
    present?.add(mention);
    // The parser also sees bare @paths inside a quoted filename. Keep those
    // cached too, so a later explicit mention does not append them again.
    if (present && mention.includes("@")) for (const path of mentionedPaths(token)) present.add(path);
  }
  return written;
}

/**
 * How much of a mentioned file an agent that reads mentions in itself gives its model
 * with the message (Claude Code), on the wire as `mention_limit` (feature file_search's
 * answer): over `max_bytes` the file is never read in (Claude Code tells its model it was
 * too large); over `max_tokens` it is left out without a word, or only its first 2,000
 * lines given when those fit; and from `note_bytes` on a file is likely to be over
 * `max_tokens`, which only the model's own count says. The app shows a note on a mention
 * of a file larger than `note_bytes`.
 */
export interface MentionLimit {
  max_bytes: number;
  max_tokens: number;
  note_bytes: number;
}

/**
 * Claude Code 2.1.299's, read from its CLI on 2026-10-26 and bracketed by a run
 * (docs/plans/2026-10-26-file-mentions.md, section 3): 262,144 bytes (`maxSizeBytes`) and
 * 25,000 tokens (`maxTokens`, which `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` in its
 * environment replaces). 60,000 bytes of TypeScript were read in whole and 65,000 were
 * not; of plain English words 80,000 were and 100,000 were not: 2.4 bytes a token, code's,
 * is where the note starts.
 */
export function claudeMentionLimit(env: Record<string, string | undefined> = {}): MentionLimit {
  const set = claudeInteger(env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS);
  // Said as at most a billion, far past any model's context, which every device reads exactly.
  const tokens = set !== undefined && set > 0 ? Math.min(set, 1_000_000_000) : 25_000;
  const maxBytes = 262_144;
  return { max_bytes: maxBytes, max_tokens: tokens, note_bytes: Math.min(maxBytes, Math.round(tokens * 2.4)) };
}

/**
 * A whole number from Claude Code's environment as Claude Code 2.1.299 reads one (its
 * `int` setting): trimmed; `1e5` (a whole number only), `5_000` or `5,000` with the
 * separator between every three digits; else what `parseInt` reads at its start
 * (`30000abc` is 30000, `1.5` is 1, `0x10` is 0). Undefined when not finite.
 */
function claudeInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  let number = Number.NaN;
  if (text.length <= 32 && /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(text)) {
    const read = Number(text);
    number = Number.isInteger(read) ? read : Number.NaN;
  } else if (text.length <= 32 && /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/.test(text)) {
    number = Number.parseInt(text.replace(/[_,\u00A0\u202F ]/g, ""), 10);
  } else {
    number = Number.parseInt(text, 10);
  }
  return Number.isFinite(number) ? number : undefined;
}

/**
 * A file Claude Code reads in a way of its own when mentioned, whatever its size: a PDF
 * (its pages, when the model takes PDFs). No note for it.
 */
export function readInItsOwnWay(path: string): boolean {
  // Its extension as Claude Code takes one (Node's extname): `.pdf` alone is a name, not one.
  return posix.extname(path).toLowerCase() === ".pdf";
}

/** What becomes of a mentioned file of `size` bytes: given whole, maybe left out, or not read in. */
export type MentionFit = "whole" | "maybe" | "unread";

export function mentionFit(size: number, limit: MentionLimit): MentionFit {
  if (size > limit.max_bytes) return "unread";
  return size > limit.note_bytes ? "maybe" : "whole";
}

/** A mention a message kept whose file the agent may not read in (`prompt.submit`'s `large_mentions`). */
export interface LargeMention {
  path: string;
  size: number;
  fit: Exclude<MentionFit, "whole">;
}

/**
 * The kept mentions (`checkMentions`'s) of files over `limit.note_bytes`, in order. A
 * folder is none: Claude Code gives its model a folder's listing.
 */
export function largeMentions(cwd: string, mentions: readonly string[], limit: MentionLimit): LargeMention[] {
  const large: LargeMention[] = [];
  let folder: string;
  try {
    folder = realpathSync(cwd);
  } catch {
    return [];
  }
  for (const path of mentions) {
    if (readInItsOwnWay(path)) continue;
    try {
      // As `checkMentions` found it: in the folder, links resolved.
      const real = realpathSync(resolve(folder, path));
      if (!real.startsWith(folder.endsWith(sep) ? folder : folder + sep)) continue;
      const stats = statSync(real);
      if (!stats.isFile()) continue;
      const fit = mentionFit(stats.size, limit);
      if (fit !== "whole") large.push({ path, size: stats.size, fit });
    } catch {
      // Gone since it was checked: nothing to say.
    }
  }
  return large;
}

/**
 * `answer` with each file hit's size in bytes (`size`), for the note an app shows on a
 * mention of a file its agent may not read in. A link is given none (its own size is not
 * the file's), nor a file whose path leads through a link (a folder swapped for one since
 * it was listed: the size would be of something outside), nor one gone since.
 */
export async function withSizes<Answer extends { folder: string; files: { path: string; kind: string; size?: number }[] }>(answer: Answer): Promise<Answer> {
  await Promise.all(
    answer.files.map(async (hit) => {
      if (hit.kind !== "file") return;
      try {
        // `folder` is a real path: one of the hit's is the same only with no link on the way.
        const path = join(answer.folder, hit.path);
        const stats = await lstat(path);
        if (stats.isFile() && (await realpath(path)) === path) hit.size = stats.size;
      } catch {
        // Gone: no size.
      }
    }),
  );
  return answer;
}
