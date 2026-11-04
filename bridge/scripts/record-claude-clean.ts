import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// What scripts/record-claude.ts takes out of a recording before it is written: the
// scratch folder's path and the home folder's, also where Claude Code streamed one in
// pieces, and the fields that describe the user rather than the stream.
//
//   node scripts/record-claude-clean.ts <recording.jsonl> <scratch folder it ran in>
//
// cleans a recording again in place.

const home = homedir();

/** The paths taken out of a recording made in `cwd`, longest first, each with what stands in for it. */
function replacements(cwd: string): [string, string][] {
  const bare = cwd.replace(/^\/private/, "");
  const paths: [string, string][] = [
    [cwd, "/tmp/aeriportal-cwd"],
    [bare, "/tmp/aeriportal-cwd"],
    [home, "/Users/dev"],
  ];
  return paths.sort((a, b) => b[0].length - a[0].length);
}

/** One recorded entry, made clean: paths replaced in every string, the user's own lists and fields left out. */
export function cleaner(cwd: string): (value: unknown, key?: string) => unknown {
  const paths = replacements(cwd);
  const clean = (value: unknown, key?: string): unknown => {
    // Lists that describe the user's setup, not the stream.
    if (["tools", "mcp_servers", "slash_commands", "skills", "plugins", "agents", "plugin_errors", "terminal_slash_commands", "betas"].includes(key ?? "") && Array.isArray(value)) return [];
    if (key === "signature" && typeof value === "string") return "signature";
    if (key === "email" || key === "organization") return "redacted";
    // When the user's own sign-in ends (Claude Code 2.1.318).
    if (key === "credential_expires_at" && typeof value === "string") return "2030-01-01T00:00:00.000Z";
    if (typeof value === "string") {
      let text = value;
      for (const [path, stand] of paths) text = text.split(path).join(stand);
      return text;
    }
    if (Array.isArray(value)) return value.map((item) => clean(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
    return value;
  };
  return clean;
}

/** The field of a streamed delta that carries its text. */
const deltaFields: Record<string, string> = { text_delta: "text", thinking_delta: "thinking", input_json_delta: "partial_json" };

interface Piece {
  delta: Record<string, string>;
  field: string;
}

/**
 * Replaces the paths in streamed text that Claude Code sent in pieces ("/Users/da",
 * "niel/…"), which `cleaner` cannot see in any one string. The pieces of each content
 * block are read as one text, and what stands in for a path goes in the piece the path
 * began in, so the pieces still add up to the cleaned whole message. Changes `lines` in place.
 */
export function cleanStreamedPaths(lines: unknown[], cwd: string): void {
  const paths = replacements(cwd);
  const blocks = new Map<string, Piece[]>();
  // The message each stream (the main one, or a subagent's) is on.
  const current = new Map<string, string>();
  for (const line of lines) {
    const message = (line as { message?: { type?: string; parent_tool_use_id?: string | null; event?: Record<string, unknown> } }).message;
    if (message?.type !== "stream_event" || !message.event) continue;
    const stream = message.parent_tool_use_id ?? "";
    const event = message.event as { type: string; index?: number; message?: { id?: string }; delta?: Record<string, string> };
    if (event.type === "message_start") current.set(stream, event.message?.id ?? `${stream}:${current.size}`);
    if (event.type !== "content_block_delta" || !event.delta) continue;
    const field = deltaFields[event.delta.type];
    if (!field || typeof event.delta[field] !== "string") continue;
    const block = `${stream}/${current.get(stream) ?? ""}/${event.index ?? 0}`;
    blocks.set(block, [...(blocks.get(block) ?? []), { delta: event.delta, field }]);
  }
  for (const pieces of blocks.values()) {
    const whole = pieces.map((piece) => piece.delta[piece.field]).join("");
    // Where each path is in the whole text, earliest first, none overlapping.
    const found: { start: number; end: number; stand: string }[] = [];
    for (let at = 0; at < whole.length; ) {
      const hit = paths.find(([path]) => whole.startsWith(path, at));
      if (hit) {
        found.push({ start: at, end: at + hit[0].length, stand: hit[1] });
        at += hit[0].length;
      } else at += 1;
    }
    if (found.length === 0) continue;
    let cleaned = "";
    let from = 0;
    for (const span of found) {
      cleaned += whole.slice(from, span.start) + span.stand;
      from = span.end;
    }
    cleaned += whole.slice(from);
    // A place in the whole text, as a place in the cleaned one; inside a path, after what stands in for it.
    const place = (at: number): number => {
      let shift = 0;
      for (const span of found) {
        if (at <= span.start) break;
        if (at < span.end) return span.start + shift + span.stand.length;
        shift += span.stand.length - (span.end - span.start);
      }
      return at + shift;
    };
    let at = 0;
    for (const piece of pieces) {
      const length = piece.delta[piece.field].length;
      piece.delta[piece.field] = cleaned.slice(place(at), place(at + length));
      at += length;
    }
  }
}

if (process.argv[1] === import.meta.filename) {
  const [file, cwd] = process.argv.slice(2);
  if (!file || !cwd) throw new Error("usage: node scripts/record-claude-clean.ts <recording.jsonl> <scratch folder it ran in>");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  cleanStreamedPaths(lines, cwd);
  const clean = cleaner(cwd);
  writeFileSync(file, lines.map((line) => JSON.stringify(clean(line))).join("\n") + "\n");
}
