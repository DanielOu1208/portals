// Token analytics (docs/plans/2026-11-06-token-analytics.md): the shapes every part of
// `src/usage/` shares. What all coding on this computer spent, read from each agent's own
// history files, kept as daily totals in `state/usage/`; what went through Portals marked.
//
// Counts only. A folder's path is kept for the user's own devices and never leaves them
// (the anonymous totals hold no folder, path, title or prompt: telemetry.ts).

/** The agents whose history is read, by the ids Portals gives them (providers/). */
export type UsageAgent = "claude" | "codex" | "pi" | "droid" | "cursor" | "hermes" | "opencode";

/** Whether a request went through Portals: a session the host ran, from when it ran it. */
export type UsageVia = "portals" | "elsewhere";

/** Tokens by type, each counted once. */
export interface TokenCounts {
  /** Input not read from the cache and not written to it. */
  input: number;
  output: number;
  cacheRead: number;
  /** Written to the cache, all lifetimes. */
  cacheWrite: number;
  /** Of `cacheWrite`, written for an hour (Claude's 1-hour cache, priced higher). */
  cacheWrite1h: number;
  /** Shown apart, already inside `output` (OpenAI's and Anthropic's output tokens hold them): never added twice. */
  reasoning: number;
  /** Requests to the model: a Claude message, a Codex token_count rise, a Pi or Droid assistant message. */
  requests: number;
}

/** One request as a reader found it, before it is added to a day. */
export interface UsageRequest extends TokenCounts {
  agent: UsageAgent;
  /** The agent's own session id (Claude's file name, Codex's session_meta id, ...). */
  session: string;
  /** Milliseconds since 1970, from the request's own timestamp. */
  at: number;
  /** As the agent names it ("claude-opus-5-5", "gpt-5.5-codex"); "unknown" when it does not say. */
  model: string;
  /** The folder the session worked in, as the agent wrote it; "" when not known. */
  folder: string;
  /** A Claude subagent's, or a Codex thread Codex started itself: counted with its parent session. */
  subagent?: boolean;
}

/** A day's totals for one agent, model, folder and via. `day` is the host's local date. */
export interface DayRow extends TokenCounts {
  /** "YYYY-MM-DD" in the host's time zone. */
  day: string;
  agent: UsageAgent;
  model: string;
  folder: string;
  via: UsageVia;
}

/** A day's tokens by hour of the host's day (all types added), for the spread over a day. */
export interface HourRow {
  day: string;
  agent: UsageAgent;
  via: UsageVia;
  /** 24 numbers, hour 0 first. */
  tokens: number[];
}

/** One reading of a plan's window, kept with its time (state/usage/limits.jsonl). */
export interface LimitReading {
  /** Milliseconds since 1970. */
  at: number;
  agent: UsageAgent;
  /** As UsageLimit names it: "5-hour", "weekly", "weekly Opus". */
  name: string;
  percent: number;
  /** Unix seconds; null when not known. */
  resetsAt: number | null;
  windowSeconds?: number;
}

/** A model's prices in US dollars per token, from LiteLLM's list (prices.ts). */
export interface ModelPrice {
  input: number;
  output: number;
  /** Absent: the input price. */
  cacheRead?: number;
  /** Absent: the input price. */
  cacheWrite?: number;
  /** Absent: twice the input price (Anthropic's 1-hour cache). */
  cacheWrite1h?: number;
}

/** What the reading of history is doing, for the app's first-scan line. */
export interface ScanState {
  /** A first read of everything is under way. */
  scanning: boolean;
  /** 0 to 1 while scanning, by bytes. */
  progress?: number;
  /** Milliseconds since 1970 of the last scan that finished. */
  scannedAt?: number;
}

/**
 * The book of usage: what the reader (scanner.ts, store.ts) gives the rest of the host.
 * One per host, started by bridge.ts; the gateway's `usage.history` and the telemetry
 * sender ask it, nothing else writes to it.
 */
export interface UsageBook {
  /** Days `from` to `to`, inclusive, "YYYY-MM-DD" host-local. */
  days(from: string, to: string): DayRow[];
  hours(from: string, to: string): HourRow[];
  scan(): ScanState;
  /** Reads what is new now (after a turn ends): debounced, never two at once. */
  poke(): void;
  stop(): Promise<void>;
}
