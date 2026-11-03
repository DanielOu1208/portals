import type { StoredMessage } from "./types.ts";

// What a turn spent (feature `turn_usage`), read from an agent's own stored conversation
// where it keeps each request's tokens: Claude Code's session, Pi's session file. Every
// message in the user's place opens a turn of its own in the app (one steered in too), so
// what was spent since the last one goes with the message before the next.

/** Adds up the tokens of each turn of a stored conversation as it is read, onto the turn's last message. */
export class TurnTokens {
  private tokens = 0;

  add(count: number | null | undefined): void {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) this.tokens += count;
  }

  /** A message in the user's place is about to be stored, or the conversation ends: the turn so far ends with `messages`' last. */
  close(messages: StoredMessage[]): void {
    const last = messages.at(-1);
    if (this.tokens > 0 && last) last.turn_usage = { ...last.turn_usage, tokens: this.tokens };
    this.tokens = 0;
  }
}

type Counts = Record<string, unknown> | null | undefined;

/** Claude's usage of a request or a result: in, cache written, cache read and out, each once. */
export function claudeTokens(usage: Counts): number {
  if (!usage || typeof usage !== "object") return 0;
  const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  return count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens") + count("output_tokens");
}

/** Pi's usage of a request (pi-ai's `Usage`): in, out, cache read and cache written, else its total. */
export function piTokens(usage: Counts): number {
  if (!usage || typeof usage !== "object") return 0;
  const parts = ["input", "output", "cacheRead", "cacheWrite"].map((key) => usage[key]);
  if (parts.some((part) => typeof part === "number")) return parts.reduce<number>((sum, part) => sum + (typeof part === "number" ? part : 0), 0);
  return typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
}
