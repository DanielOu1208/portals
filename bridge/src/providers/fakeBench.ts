import type { ProviderEvent } from "./types.ts";

// The fake agent's long reply for measuring the app (`bench` in the prompt), shaped
// like a real coding agent's: headings, lists, code blocks, a table and some $math$,
// with tool calls between the paragraphs (a file read, edits with diffs, commands and
// their output). The text comes in small pieces every 30–80 ms, the way Claude Code's
// and Codex's deltas arrive, for a little over a minute. `instant` sends the same
// reply at once, in whole paragraphs, to give a thread a long history quickly. `whole`
// sends its text as one long answer, with no tool calls between its parts.
//
// The pieces and pauses come from a fixed seed, so every run streams the same events
// at the same pace: two builds of the app can be compared on the same reply.

export type BenchStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; result: unknown; durationSeconds: number };

/** What the reply does: what is said, and the tool calls between. */
export function benchSteps(round: number): BenchStep[] {
  const steps: BenchStep[] = [];
  for (let part = 1; part <= 3; part += 1) {
    const file = `Sources/Engine/Part${part}.swift`;
    steps.push({ kind: "text", text: intro(part, round) });
    steps.push({ kind: "tool", name: "read", args: { path: file }, result: { content: swiftFile(part, false) }, durationSeconds: 0.04 });
    steps.push({ kind: "text", text: analysis(part) });
    steps.push({
      kind: "tool",
      name: "patch",
      args: { path: file, old_string: "let total = values.reduce(0, +)", new_string: "let total = values.reduce(into: 0) { $0 += $1 }" },
      result: { success: true, diff: diff(file, part) },
      durationSeconds: 0.11,
    });
    steps.push({
      kind: "tool",
      name: "terminal",
      args: { command: `swift test --filter Part${part}Tests` },
      result: { output: testOutput(part), exit_code: 0 },
      durationSeconds: 3.2,
    });
    steps.push({ kind: "text", text: results(part) });
  }
  steps.push({ kind: "text", text: summary(round) });
  return steps;
}

/** A small deterministic random source (mulberry32). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `text` cut into the small pieces a streaming model sends: 2 to 14 characters each. */
export function pieces(text: string, random: () => number): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const size = 2 + Math.floor(random() * 13);
    out.push(text.slice(at, at + size));
    at += size;
  }
  return out;
}

export interface BenchPlayer {
  emit(event: ProviderEvent): void;
  /** Waits `ms`, or throws when the turn is interrupted. */
  wait(ms: number): Promise<void>;
  toolID(): string;
}

/**
 * Plays the reply: in real time, or at once with `instant`. `coarse` sends the same
 * text on the same schedule in half as many pieces, twice as large: each two pieces
 * as one, after the two pauses they would have had, so the only difference is how
 * many pieces there are, to tell what costs the app per piece from what costs it per
 * character.
 */
export async function playBench(player: BenchPlayer, round: number, instant: boolean, coarse = false, whole = false): Promise<void> {
  const random = seeded(1208 + round);
  // `whole`: the reply's text as one long answer, with no tool calls between its parts
  // (each part a text of its own in the app otherwise), as an agent's final summary comes.
  const steps: BenchStep[] = whole
    ? [{ kind: "text", text: benchSteps(round).flatMap((step) => (step.kind === "text" ? [step.text] : [])).join("\n\n") }]
    : benchSteps(round);
  for (const step of steps) {
    if (step.kind === "text") {
      if (instant) {
        player.emit({ type: "text", text: step.text });
        continue;
      }
      // The pieces, then the pause after each, drawn in that order whatever the mode.
      const all = pieces(step.text, random);
      const pauses = all.map(() => 30 + Math.floor(random() * 51));
      const together = coarse ? 2 : 1;
      for (let index = 0; index < all.length; index += together) {
        player.emit({ type: "text", text: all.slice(index, index + together).join("") });
        await player.wait(pauses.slice(index, index + together).reduce((sum, pause) => sum + pause, 0));
      }
    } else {
      const id = player.toolID();
      player.emit({ type: "tool.start", id, name: step.name, args: step.args });
      if (!instant) await player.wait(Math.round(step.durationSeconds * 300));
      player.emit({ type: "tool.end", id, name: step.name, args: step.args, result: step.result, durationSeconds: step.durationSeconds });
      if (!instant) await player.wait(120);
    }
  }
}

function intro(part: number, round: number): string {
  return [
    `## Part ${part}: the engine's ${["parser", "scheduler", "cache"][part - 1]} (round ${round})`,
    "",
    `I read through the ${["parser", "scheduler", "cache"][part - 1]} first, to see where the time goes before changing anything. ` +
      "The short version: most of the cost is in one loop that re-reads the whole buffer every time a new piece arrives, " +
      "so the work grows with the square of the input. Here is what I looked at, in order:",
    "",
    "1. **The entry point**, `Engine.run(_:)`, which takes the input and hands it to the stages one by one.",
    "2. **The hot loop** in `Stage.advance()`, called once per piece of input. It walks `buffer` from the start.",
    "3. **The cache**, which is keyed by the whole buffer's hash, so it never hits while the input grows.",
    "   - The hash itself is `O(n)`, so even a miss costs as much as the work it was meant to save.",
    "   - Entries are never evicted, so a long session holds every intermediate state.",
    "4. **The output stage**, which is fine: it only looks at what changed.",
    "",
    "Let me open the file to confirm.",
    "",
  ].join("\n");
}

function analysis(part: number): string {
  return [
    `That confirms it. The loop in \`advance()\` costs $\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$ steps for $n$ pieces, ` +
      `so for a reply of $n = 2000$ pieces that is about $2 \\times 10^{6}$ visits, where $O(n)$ would be $2000$. ` +
      "The fix is to keep the position reached last time and only look at what is new:",
    "",
    "```swift",
    "struct Stage {",
    "    private var settled = 0",
    "    private var state = State()",
    "",
    "    mutating func advance(_ buffer: [Piece]) -> [Output] {",
    "        defer { settled = buffer.count }",
    "        // Only what arrived since the last call.",
    "        return buffer[settled...].compactMap { piece in",
    "            state.consume(piece)",
    "        }",
    "    }",
    "}",
    "```",
    "",
    `With that, the cost per piece is constant, and the whole run is $T(n) = c \\cdot n$. I'll make the change in part ${part} now.`,
    "",
  ].join("\n");
}

function results(part: number): string {
  return [
    `The tests for part ${part} pass. Here is how the timings moved on the benchmark inputs:`,
    "",
    "| Input | Pieces | Before (ms) | After (ms) | Change |",
    "| --- | ---: | ---: | ---: | ---: |",
    "| short reply | 120 | 1.9 | 0.4 | −79% |",
    "| long reply | 2,000 | 412.0 | 6.1 | −98.5% |",
    "| huge log | 25,000 | 61,200.0 | 74.8 | −99.9% |",
    "| empty | 0 | 0.0 | 0.0 | — |",
    "",
    "> The huge log was the case that timed out in CI. It now takes well under a tenth of a second.",
    "",
    "A few things to note before moving on:",
    "",
    "- The cache is now keyed by the stage's position, not the whole buffer, so it hits on every call after the first.",
    "- Memory stays flat: the stage keeps its `state` and a single index, nothing per piece.",
    "- The ratio of the two curves is $\\lim_{n \\to \\infty} \\frac{n^2}{n} = \\infty$, which is why the huge input was the one that failed.",
    "",
  ].join("\n");
}

function summary(round: number): string {
  return [
    "## Summary",
    "",
    `All three parts are done (round ${round}). What changed:`,
    "",
    "- `Part1.swift`: the parser keeps its position between calls.",
    "- `Part2.swift`: the scheduler no longer re-sorts the whole queue on each insert; it uses a heap, so an insert is $O(\\log n)$.",
    "- `Part3.swift`: the cache is keyed by position and evicts the oldest entries past 256.",
    "",
    "The overall effect on the end-to-end benchmark:",
    "",
    "$$\\text{speedup} = \\frac{T_{\\text{before}}}{T_{\\text{after}}} = \\frac{61.2\\,\\text{s}}{0.075\\,\\text{s}} \\approx 816$$",
    "",
    "Next, I'd suggest running the full suite once more and then looking at the output stage, which is now the largest share of the time. " +
      "Let me know if you want me to go on with that, or to write up the change for review first.",
    "",
  ].join("\n");
}

function swiftFile(part: number, fixed: boolean): string {
  const lines = [
    "import Foundation",
    "",
    `/// Part ${part} of the engine.`,
    "struct Stage {",
    "    var buffer: [Piece] = []",
    "",
    "    mutating func advance(_ values: [Int]) -> Int {",
    fixed ? "        let total = values.reduce(into: 0) { $0 += $1 }" : "        let total = values.reduce(0, +)",
    "        for index in buffer.indices {",
    "            buffer[index].visit()",
    "        }",
    "        return total",
    "    }",
    "}",
  ];
  for (let index = 0; index < 30; index += 1) lines.push(`// filler line ${index} of part ${part}`);
  return lines.join("\n");
}

function diff(file: string, part: number): string {
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -5,9 +5,10 @@ struct Stage {",
    "     var buffer: [Piece] = []",
    "+    private var settled = 0",
    " ",
    "     mutating func advance(_ values: [Int]) -> Int {",
    "-        let total = values.reduce(0, +)",
    "-        for index in buffer.indices {",
    "+        let total = values.reduce(into: 0) { $0 += $1 }",
    "+        defer { settled = buffer.count }",
    "+        for index in buffer.indices.dropFirst(settled) {",
    "             buffer[index].visit()",
    "         }",
    `         return total // part ${part}`,
    "",
  ].join("\n");
}

function testOutput(part: number): string {
  const lines = ["Building for debugging...", `[${part * 3}/${part * 3 + 4}] Compiling Engine Part${part}.swift`, "Build complete! (2.84s)"];
  for (let index = 1; index <= 12; index += 1) {
    lines.push(`Test Case '-[EngineTests.Part${part}Tests testCase${index}]' passed (0.00${index} seconds).`);
  }
  lines.push(`Executed 12 tests, with 0 failures (0 unexpected) in 0.041 (0.043) seconds`);
  return lines.join("\n");
}
