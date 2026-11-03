// What a search looks for and how a message's text is matched against it (feature
// thread_search, docs/plans/2026-10-26-thread-search.md).
//
// A query is words and quoted phrases. Text and query are both folded the same way:
// decomposed (NFKD), combining marks removed, lower-cased, and every run of white space
// made one space. So `café`, `CAFE` and `Café` are the same word, and a phrase matches
// across a line break. A message is a hit when its folded text holds every word and
// phrase of the query, each beginning where a word of the text begins.
//
// Where a word begins (2026-10-26: "Start of words"): `deploy` finds `deployment`
// and `log` finds `login`, but not `catalog`. A word is letters and digits; anything else
// (white space, punctuation, `_`, an emoji) ends one, so `search` finds `thread_search`
// and `thread-search`. A capital after a small letter or a digit begins a word too, as
// does the last capital of a run before a small letter (`threadSearch`, `HTTPServer`):
// agents' talk is full of names written so, and `search` finding `threadSearch` is what
// a person means. Letters and digits are one word (`v2`, `utf8`): `2` does not find
// `v2`. In a script written without spaces between words (Chinese, Japanese, Thai and
// the like) there is no telling where a word begins: a term that starts with one of
// its letters matches anywhere, and a word right after one of its letters begins there
// (`swift` in `用Swift写`). A term that starts with neither a letter nor a digit (`.env`,
// `🚀`, `#12`) matches anywhere. A phrase's first word must begin a word; its last may
// run on into a longer one (`"relay push"` finds `relay pushes`), as a single word does,
// so that a phrase is no stricter at its end than its words are one by one.

/** At most this many words and phrases are taken from a query: the rest are ignored. */
export const maxTerms = 8;
/** The longest query taken, in characters. */
export const maxQueryLength = 200;
/** About how long a snippet is, in UTF-16 code units, before the ellipses. */
export const snippetLength = 200;
/** How much of a snippet comes before its first match, at most. */
const leadLength = 60;
/** At most this many ranges are marked in one snippet. */
const maxRanges = 20;

export interface Query {
  /** The words and phrases, folded, longest first (the rarest, as a rule, is tested first). */
  terms: string[];
  /**
   * For each term, its longest run of letters and digits: what a line of an agent's file
   * must hold, as it stands or folded, before it is worth parsing.
   */
  needles: string[];
  /**
   * The needles as patterns that ignore case, tested on a line as it stands: a line that
   * holds every one needs no folding, and an ASCII line that misses one cannot hold a hit.
   */
  patterns: RegExp[];
}

/** A matched stretch of a snippet, in UTF-16 code units: `start` included, `end` not. */
export interface Range {
  start: number;
  end: number;
}

export interface Snippet {
  text: string;
  ranges: Range[];
}

const marks = /\p{M}/gu;
/** What a word is made of: letters and digits. */
const wordChar = /[\p{L}\p{N}]/u;
/** Scripts written without spaces between words: each of their letters stands by itself. */
const unspaced = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Bopomofo}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\p{scx=Tibetan}\p{scx=Yi}]/u;
/** Whether a text has a capital at all, which may begin a word inside a longer one (`threadSearch`). */
const capital = /[\p{Lu}\p{Lt}]/u;
const space = /\s+/gu;
const nonAscii = /[^\x00-\x7f]/;
/** A JSON escape of anything but a control character (those are `\u0000` to `\u001f`, and `\u007f`). */
const escapedLetter = /\\u(?!00[01]|007f)[0-9a-fA-F]{4}/i;

/**
 * Text as it is compared: NFKD, without combining marks, lower case, one space for every
 * run of white space. A final sigma is the sigma it is anywhere else (lower-casing a whole
 * string gives `ς` at a word's end, a single letter `σ`).
 */
export function fold(text: string): string {
  if (!nonAscii.test(text)) return text.toLowerCase().replace(space, " ");
  // The marks written out removed before decomposing too: decomposing puts each run of
  // them in order, which takes the square of its length, and they go anyway.
  return text.replace(marks, "").normalize("NFKD").replace(marks, "").toLowerCase().replace(/ς/g, "σ").replace(space, " ");
}

/** A line as the cheap test before parsing sees it: folded only when it has to be. */
export function foldLine(line: string): string {
  return nonAscii.test(line) ? line.replace(marks, "").normalize("NFKD").replace(marks, "").toLowerCase().replace(/ς/g, "σ") : line.toLowerCase();
}

/** The query's words and phrases; null when it has none to look for. */
export function parseQuery(given: string): Query | null {
  const text = given.slice(0, maxQueryLength);
  const terms: string[] = [];
  const phrase = /"([^"]*)"?|(\S+)/gu;
  for (const match of text.matchAll(phrase)) {
    const term = fold(match[1] ?? match[2] ?? "").trim();
    if (term !== "" && !terms.includes(term)) terms.push(term);
  }
  // A word that begins a word of another term, or of a phrase, is found by it already.
  const kept = terms.filter((term) => !terms.some((other) => other !== term && firstStart(other, term) !== -1));
  if (kept.length === 0) return null;
  kept.sort((a, b) => b.length - a.length);
  const chosen = kept.slice(0, maxTerms);
  const needles = chosen.map(needle);
  return { terms: chosen, needles, patterns: needles.map((each) => new RegExp(each.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu")) };
}

/**
 * A term's longest run of letters and digits; for a term with none (`---`), its longest
 * run of what JSON writes as it stands: no white space (a line break is `\n` there), no
 * quote, no backslash, no control character. Empty when it has neither: every line may hold it.
 */
function needle(term: string): string {
  const longest = (runs: string[]) => runs.reduce((best, run) => (run.length > best.length ? run : best), "");
  return longest(term.match(/[\p{L}\p{N}]+/gu) ?? []) || longest(term.match(/[^\s"\\\p{Cc}]+/gu) ?? []);
}

/**
 * Whether a raw line of an agent's file may hold every term: each term's needle is in it,
 * folded. A line that fails cannot hold a hit, whatever its JSON says, except where JSON
 * wrote a letter as `\uXXXX`, which agents' files do only for control characters.
 */
export function mayHold(line: string, query: Query): boolean {
  const unfolded = mayHoldUnfolded(line, query);
  if (unfolded !== "fold") return unfolded;
  const folded = foldLine(line);
  return query.needles.every((needle) => folded.includes(needle));
}

/**
 * `mayHold` without folding: true when the raw text has every needle as it stands, or
 * escapes a letter (`caf\u00e9`, which only parsing reads); false when it is plain ASCII
 * without them; `fold` when only folding its other letters can tell.
 */
export function mayHoldUnfolded(text: string, query: Query): boolean | "fold" {
  // Most lines are tool output in plain ASCII: tested without a lower-cased copy of each.
  if (query.patterns.every((pattern) => pattern.test(text))) return true;
  if (escapedLetter.test(text)) return true;
  return nonAscii.test(text) ? "fold" : false;
}

/** The code point of `text` that ends at `at`; empty at its start. */
function charBefore(text: string, at: number): string {
  if (at <= 0) return "";
  const low = text.charCodeAt(at - 1);
  if (low >= 0xdc00 && low <= 0xdfff && at >= 2) {
    const high = text.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(at - 2, at);
  }
  return text[at - 1];
}

/** The code point of `text` that starts at `at`. */
function charAt(text: string, at: number): string {
  const point = text.codePointAt(at);
  return point === undefined ? "" : String.fromCodePoint(point);
}

/** Whether a term is found wherever it is: it starts with neither a letter nor a digit, or with a letter of a script written without spaces. */
function matchesAnywhere(term: string): boolean {
  const first = charAt(term, 0);
  return !wordChar.test(first) || unspaced.test(first);
}

/** Whether a word may begin after `before` (folded): it is nothing (the text's start), not a letter or digit, or a letter of a script without spaces. */
function endsAWord(before: string): boolean {
  return before === "" || !wordChar.test(before) || unspaced.test(before);
}

/**
 * Where in folded text `term` first begins a word, as far as the folded text can tell
 * (a capital inside a word, which folding lowers, is `humpAt`'s); -1 for nowhere.
 */
function firstStart(folded: string, term: string): number {
  const anywhere = matchesAnywhere(term);
  for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1)) {
    if (anywhere || endsAWord(charBefore(folded, at))) return at;
  }
  return -1;
}

/**
 * Whether the character of the original text at `at` is a capital that begins a word
 * inside a longer one, `before` being where the character before it starts: after a
 * small letter or a digit (`threadSearch`, `utf8Decoder`), or the last capital of a run,
 * before a small letter (`HTTPServer`).
 */
function humpAt(text: string, before: number, at: number): boolean {
  if (before < 0 || before >= at) return false;
  const code = text.charCodeAt(at);
  // Most text is ASCII, and most of its letters are small.
  if (code < 0x80 && !(code >= 0x41 && code <= 0x5a)) return false;
  const char = charAt(text, at);
  if (!/[\p{Lu}\p{Lt}]/u.test(char)) return false;
  const previous = charAt(text, before);
  if (/[\p{Ll}\p{N}]/u.test(previous)) return true;
  if (!/\p{Lu}/u.test(previous)) return false;
  return /\p{Ll}/u.test(charAt(text, pastMarks(text, at + char.length)));
}

/**
 * Where the character before `at` that folds to something starts, as the folded text
 * has it before `at` (combining marks, and a few others that decompose into them, fold
 * to nothing); -1 at the text's start.
 */
function shownBefore(text: string, at: number): number {
  for (let end = at; end > 0; ) {
    const char = charBefore(text, end);
    end -= char.length;
    if (char.charCodeAt(0) < 0x80 || fold(char) !== "") return end;
  }
  return -1;
}

/** The folded text of `text` from `at` on, at least `length` units of it where the text has them. */
function foldedFrom(text: string, at: number, length: number): string {
  for (let size = length * 2 + 16; ; size *= 2) {
    const to = onBoundary(text, Math.min(text.length, at + size));
    const folded = fold(text.slice(at, to));
    if (folded.length >= length || to >= text.length) return folded;
  }
}

/**
 * Where in `text` (original offsets) `term` first begins at a capital inside a word
 * (`humpAt`: `Search` of `threadSearch`), before `before`; -1 for nowhere. Found by
 * the capitals of the original text that fold to the term's first letter (an ASCII
 * letter's own capital, or any capital outside ASCII), each told by what is before it
 * and folded from there: each character is looked at a bounded number of times.
 */
function firstHump(text: string, term: string, before = text.length): number {
  const letter = term[0];
  const capitals = /^[a-z]$/.test(letter) ? new RegExp(`${letter.toUpperCase()}|(?![\\x00-\\x7f])[\\p{Lu}\\p{Lt}]`, "gu") : /[\p{Lu}\p{Lt}]/gu;
  for (const found of text.matchAll(capitals)) {
    if (found.index >= before) break;
    if (fold(found[0])[0] !== letter) continue;
    if (humpAt(text, shownBefore(text, found.index), found.index) && foldedFrom(text, found.index, term.length).startsWith(term)) return found.index;
  }
  return -1;
}

/** Whether a message's text holds every term, each beginning a word. */
export function holds(text: string, query: Query): boolean {
  if (text === "") return false;
  const folded = fold(text);
  for (const term of query.terms) {
    if (firstStart(folded, term) !== -1) continue;
    // Found only inside words, if at all: at a capital that begins one (`threadSearch`)?
    if (!folded.includes(term) || !capital.test(text) || firstHump(text, term) === -1) return false;
  }
  return true;
}

/**
 * The folded text of `text` from `from` to `to` with, for each of its UTF-16 units, the
 * stretch of the original text it came from: `starts[k]` to `ends[k]`.
 */
function foldedWithMap(text: string, from: number, to: number): { folded: string; starts: Int32Array; ends: Int32Array } {
  const parts: string[] = [];
  let starts = new Int32Array(to - from + 16);
  let ends = new Int32Array(to - from + 16);
  let length = 0;
  walkFolded(text, from, to, { inSpace: false }, (unit, start, end) => {
    if (length === starts.length) {
      const grow = (old: Int32Array) => {
        const bigger = new Int32Array(old.length * 2);
        bigger.set(old);
        return bigger;
      };
      starts = grow(starts);
      ends = grow(ends);
    }
    parts.push(unit);
    starts[length] = start;
    ends[length] = end;
    length += 1;
  });
  return { folded: parts.join(""), starts: starts.subarray(0, length), ends: ends.subarray(0, length) };
}

/**
 * The folded text of `text` from `from` to `to`, one UTF-16 unit at a time, each with
 * the stretch of the original it came from, folded as `fold` folds the whole: `state`
 * carries the white space run on from one stretch to the next.
 */
function walkFolded(text: string, from: number, to: number, state: { inSpace: boolean }, put: (unit: string, start: number, end: number) => void): number {
  let inSpace = state.inSpace;
  let index = from;
  while (index < to) {
    const code = text.charCodeAt(index);
    // Plain ASCII, most of any text: no normalizing, no pattern.
    if (code < 0x80) {
      const space = code === 0x20 || (code >= 0x09 && code <= 0x0d);
      if (space) {
        if (!inSpace) put(" ", index, index + 1);
      } else put(code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : text[index], index, index + 1);
      inSpace = space;
      index += 1;
      continue;
    }
    const width = code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
    const char = text.slice(index, index + width);
    // As `fold` makes it: what a character comes to may hold white space (`¨` is a space and a mark), joined with the white space around it.
    const out = /\s/u.test(char) ? " " : char.normalize("NFKD").replace(marks, "").toLowerCase().replace(/ς/g, "σ");
    for (const unit of out) {
      const space = /\s/u.test(unit);
      if (space) {
        if (!inSpace) put(" ", index, index + width);
      } else for (let at = 0; at < unit.length; at += 1) put(unit[at], index, index + width);
      inSpace = space;
    }
    index += width;
  }
  state.inSpace = inSpace;
  // Past a surrogate pair that straddled `to`.
  return index;
}

/**
 * The last character before `at` that folds to something (combining marks fold to
 * nothing), folded, and where it starts; null at the text's start.
 */
function foldedBefore(text: string, at: number): { unit: string; start: number } | null {
  for (let end = at; end > 0; ) {
    const char = charBefore(text, end);
    end -= char.length;
    const folded = fold(char);
    if (folded !== "") return { unit: charBefore(folded, folded.length), start: end };
  }
  return null;
}

/**
 * Every stretch of `text` from `from` to `to` (original offsets) that matches a term
 * where it begins a word, in order, overlapping ones joined. What comes before `from`
 * says whether a word begins there.
 */
export function matches(text: string, query: Query, from = 0, to = text.length): Range[] {
  const { folded, starts, ends } = foldedWithMap(text, from, to);
  const before = from > 0 ? foldedBefore(text, from) : null;
  const begins = (at: number): boolean => {
    if (at > 0) return endsAWord(charBefore(folded, at)) || humpAt(text, starts[at - 1], starts[at]);
    return !before || endsAWord(before.unit) || humpAt(text, before.start, starts[0]);
  };
  const found: Range[] = [];
  for (const term of query.terms) {
    const anywhere = matchesAnywhere(term);
    for (let at = folded.indexOf(term); at !== -1 && found.length < 1000; ) {
      if (anywhere || begins(at)) {
        found.push({ start: starts[at], end: pastMarks(text, ends[at + term.length - 1], to) });
        at = folded.indexOf(term, at + Math.max(term.length, 1));
      } else at = folded.indexOf(term, at + 1);
    }
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const joined: Range[] = [];
  for (const range of found) {
    const last = joined.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else joined.push({ ...range });
  }
  return joined;
}

/** Past the combining marks after `end` (and what folds to nothing as they do): they belong to the letter before. */
function pastMarks(text: string, end: number, to = text.length): number {
  let at = end;
  while (at < to) {
    if (text.charCodeAt(at) < 0x80) break;
    const char = charAt(text, at);
    if (fold(char) !== "") break;
    at += char.length;
  }
  return at;
}

/**
 * How much of a message is walked at a time to find where its first match starts: about
 * 2 ms of plain ASCII, or of other letters (each normalized by itself, ten times slower) a
 * quarter as much.
 */
const walkLength = 32 * 1024;
const otherWalkLength = 8 * 1024;

/**
 * Where in `text` its first match starts: found in the folded text, which `holds` folds
 * whole as well, and brought back to the original by walking the text a stretch at a
 * time, the event loop given its turn between: a message of megabytes is never mapped
 * whole at once. Null when it holds no match.
 */
async function firstMatchStart(text: string, query: Query, pause: () => Promise<void>): Promise<number | null> {
  const step = nonAscii.test(text) ? otherWalkLength : walkLength;
  // Folded a stretch at a time too: the stretches' white space joined where they meet.
  const parts: string[] = [];
  // Whether what is folded so far ends in white space: a stretch of white space only folds to one space, and to none after it.
  let inSpace = false;
  for (let from = 0; from < text.length; ) {
    const to = onBoundary(text, Math.min(text.length, from + step * 8));
    let part = fold(text.slice(from, to));
    if (inSpace && part.startsWith(" ")) part = part.slice(1);
    if (part !== "") {
      parts.push(part);
      inSpace = part.endsWith(" ");
    }
    from = to;
    if (from < text.length) await pause();
  }
  const folded = parts.join("");
  // Where a term first begins a word, as the folded text tells; one may begin sooner at a
  // capital inside a word (`threadSearch`), which only the original's letters tell.
  let first = -1;
  for (const term of query.terms) {
    const at = firstStart(folded, term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  // The first's place in the original.
  let found = -1;
  if (first !== -1) {
    const state = { inSpace: false };
    let count = 0;
    for (let from = 0; from < text.length && found === -1; ) {
      from = walkFolded(text, from, Math.min(text.length, from + step), state, (_unit, start) => {
        if (count === first && found === -1) found = start;
        count += 1;
      });
      if (found === -1) await pause();
    }
  }
  // A capital before it that begins a term inside a word.
  if (capital.test(text)) {
    for (const term of query.terms) {
      const at = firstHump(text, term, found === -1 ? text.length : found);
      if (at !== -1) found = at;
    }
  }
  return found === -1 ? null : found;
}

/** Not in the middle of a surrogate pair. */
function onBoundary(text: string, at: number): number {
  if (at <= 0 || at >= text.length) return Math.max(0, Math.min(at, text.length));
  const unit = text.charCodeAt(at);
  return unit >= 0xdc00 && unit <= 0xdfff ? at - 1 : at;
}

/**
 * A stretch of `text` around its first match, of about `snippetLength` units, with the
 * matches in it as ranges into the snippet. White space is shown as single spaces (each
 * white-space unit one space, so the offsets hold), and an ellipsis marks text left out
 * at either end. Null when the text holds no match.
 */
export async function snippet(text: string, query: Query, pause: () => Promise<void> = async () => {}): Promise<Snippet | null> {
  const at = await firstMatchStart(text, query, pause);
  if (at === null) return null;
  let start = Math.max(0, at - leadLength);
  // Start at a word where one is near.
  if (start > 0) {
    const gap = text.slice(start, at).search(/\s/u);
    if (gap !== -1 && start + gap + 1 <= at) start += gap + 1;
  }
  start = onBoundary(text, start);
  const end = onBoundary(text, Math.min(text.length, start + snippetLength));
  const before = start > 0 ? "…" : "";
  const after = end < text.length ? "…" : "";
  const body = text.slice(start, end).replace(/\s/gu, " ");
  // A small window past the displayed text lets a later match cross the cut and still
  // be marked. Starting at the proved first match avoids scanning back through accents.
  const near = onBoundary(text, Math.min(text.length, end + 256));
  const found = matches(text.slice(at, near), query).map((range) => ({ start: range.start + at, end: range.end + at }));
  // The first match is already proved, even when its phrase continues past the window.
  // Its visible part still needs a highlight when the bounded mapping cannot see its end.
  if (!found.some((range) => range.start === at)) found.splice(0, found.length, { start: at, end });
  const ranges = found
    .filter((range) => range.start < end && range.end > start)
    .slice(0, maxRanges)
    .map((range) => ({ start: Math.max(range.start, start) - start + before.length, end: Math.min(range.end, end) - start + before.length }));
  return { text: `${before}${body}${after}`, ranges };
}
