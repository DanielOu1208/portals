// JSON for the app. Swift's JSONDecoder refuses a whole document that holds half of a
// surrogate pair ("Missing low code point in surrogate pair"), which JSON.stringify writes
// as an escape of its own (`\ud83d`) when a string was cut in the middle of a character
// outside the Basic Multilingual Plane, an emoji: a title, a name or a summary cut to a
// length in UTF-16 units. The app's peer skips such a frame, so the call it answers never
// comes back, and the list or event in it is lost. Such a half is sent as U+FFFD.

/**
 * A lone surrogate as JSON.stringify writes it: `\ud800` to `\udfff`, after an even run
 * of backslashes (an odd one makes it the text `\ud83d`, its backslash escaped). A whole
 * pair is written as it is, never as escapes.
 */
const loneSurrogate = /(?<!\\)((?:\\\\)*)\\ud[89a-f][0-9a-f]{2}/g;

/** `JSON.stringify(value)`, with any half of a surrogate pair written as U+FFFD. */
export function wellFormedJSON(value: unknown): string {
  const text = JSON.stringify(value);
  // Rare: one look over the text, and nothing more, for every other frame.
  return text.includes("\\ud") ? text.replace(loneSurrogate, "$1\\ufffd") : text;
}

/** The first `most` UTF-16 units of `text`, less half of a surrogate pair at the end. */
export function cutWhole(text: string, most: number): string {
  if (text.length <= most) return text;
  const code = text.charCodeAt(most - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? most - 1 : most);
}
