import { unifiedDiff, type Hunk } from "../claude/tools.ts";

// A unified diff from a file's text before and after. The protocol gives an edit as
// the two texts (`oldText`, `newText`), whole; the app shows a diff.

/** Lines around a change that are shown with it. */
const context = 3;
/** Above this many line pairs the changed part is shown as one block replaced, not compared line by line. */
const compareLimit = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

type Step = { kind: " " | "-" | "+"; line: string };

/**
 * The steps from `before` to `after`: what is the same on both sides is found first
 * from the ends, which is most of a file in most edits, and the middle is compared by
 * its longest common run of lines.
 */
function steps(before: string[], after: string[]): Step[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;

  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  const out: Step[] = before.slice(0, start).map((line) => ({ kind: " ", line }));
  for (const step of middle(removed, added)) out.push(step);
  for (const line of before.slice(before.length - end)) out.push({ kind: " ", line });
  return out;
}

function middle(removed: string[], added: string[]): Step[] {
  const rows = removed.length;
  const columns = added.length;
  if (rows === 0 || columns === 0 || rows * columns > compareLimit) {
    return [...removed.map((line): Step => ({ kind: "-", line })), ...added.map((line): Step => ({ kind: "+", line }))];
  }
  // lengths[i][j]: the longest common run of removed[i…] and added[j…].
  const width = columns + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = removed[i] === added[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const out: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (removed[i] === added[j]) {
      out.push({ kind: " ", line: removed[i] });
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      out.push({ kind: "-", line: removed[i++] });
    } else {
      out.push({ kind: "+", line: added[j++] });
    }
  }
  while (i < rows) out.push({ kind: "-", line: removed[i++] });
  while (j < columns) out.push({ kind: "+", line: added[j++] });
  return out;
}

/** The changes with their surroundings, as hunks with line numbers. */
function hunks(all: Step[]): Hunk[] {
  const out: Hunk[] = [];
  // Where each step falls in the old and the new file, counted from 1.
  let oldLine = 1;
  let newLine = 1;
  const positions = all.map((step) => {
    const at = { oldLine, newLine };
    if (step.kind !== "+") oldLine += 1;
    if (step.kind !== "-") newLine += 1;
    return at;
  });
  let index = 0;
  while (index < all.length) {
    if (all[index].kind === " ") {
      index += 1;
      continue;
    }
    const from = Math.max(0, index - context);
    // The hunk runs on while the next change is within reach of this one's surroundings.
    let last = index;
    for (let next = index + 1; next < all.length && next - last <= context * 2; next += 1) {
      if (all[next].kind !== " ") last = next;
    }
    const to = Math.min(all.length, last + context + 1);
    const part = all.slice(from, to);
    out.push({
      oldStart: part.some((step) => step.kind !== "+") ? positions[from].oldLine : positions[from].oldLine - 1,
      oldLines: part.filter((step) => step.kind !== "+").length,
      newStart: part.some((step) => step.kind !== "-") ? positions[from].newLine : positions[from].newLine - 1,
      newLines: part.filter((step) => step.kind !== "-").length,
      lines: part.map((step) => `${step.kind}${step.line}`),
    });
    index = to;
  }
  return out;
}

/** The unified diff of a file whose text went from `before` to `after`; "" when nothing changed. */
export function textDiff(path: string, before: string, after: string, cwd: string): string {
  const changed = hunks(steps(splitLines(before), splitLines(after)));
  return changed.length === 0 ? "" : unifiedDiff(path, changed, cwd);
}
