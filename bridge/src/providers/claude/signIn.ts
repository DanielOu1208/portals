import { machineWord } from "../../platform.ts";
import { notSignedIn, signInCommands, signInHint } from "../signIn.ts";

// Claude Code's sign-in, as the threads are told of it. A stored claude.ai login ends for
// good on a fixed date, which renewing its access token does not move. Claude Code says
// when, on each result (`credential_expires_at`) and in `claude auth status --json`
// (`loginExpiresAt`), since 2.1.318. From ten days before, as `claude -p` warns, each
// thread says so once a day; once it has ended, a turn refused for the sign-in says that.
// Both name what to run on the host: Claude Code's own words name its /login, which the
// app does not have.

/** How long before the sign-in ends the threads start to say so. */
export const warnDays = 10;

const dayMs = 24 * 60 * 60_000;

/** How Claude Code signs in when the bridge runs it (`claude.apiKey`, `claude.oauthToken`, or its own login). */
export type ClaudeCredential = "login" | "apiKey" | "oauthToken";

/** What one thread's stream asks of the sign-in. */
export interface ThreadSignIn {
  /** A result said when the sign-in ends (`credential_expires_at`). */
  heard(endsAt: unknown): void;
  /** The notice this thread gives now, if any: from ten days before the end, once a day. */
  notice(): string | null;
  /** What a turn Claude Code refused for the sign-in (`authentication_failed`) ends with. */
  refused(): string;
}

export class ClaudeSignIn {
  /** When the sign-in ends, as Claude Code last said; null while it has not said. */
  private endsAt: number | null = null;
  /** The threads told today, and which day that is. */
  private told = { day: "", threads: new Set<string>() };
  private readonly credential: ClaudeCredential;
  private readonly now: () => number;
  private readonly timeZone: string | undefined;

  constructor(options: { credential: ClaudeCredential; now?: () => number; timeZone?: string }) {
    this.credential = options.credential;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone;
  }

  /** Claude Code said when the sign-in ends, as an ISO 8601 instant; anything else says nothing. */
  heard(endsAt: unknown): void {
    if (typeof endsAt !== "string") return;
    const at = Date.parse(endsAt);
    if (Number.isFinite(at)) this.endsAt = at;
  }

  thread(id: string): ThreadSignIn {
    return { heard: (endsAt) => this.heard(endsAt), notice: () => this.notice(id), refused: () => this.refused() };
  }

  private notice(thread: string): string | null {
    const now = this.now();
    if (this.endsAt === null || this.endsAt <= now || this.endsAt - now > warnDays * dayMs) return null;
    const today = new Date(now).toLocaleDateString("en-CA", { timeZone: this.timeZone });
    if (this.told.day !== today) this.told = { day: today, threads: new Set() };
    if (this.told.threads.has(thread)) return null;
    this.told.threads.add(thread);
    const day = new Date(this.endsAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: this.timeZone });
    return `Claude Code's sign-in on this ${machineWord()} ends on ${day}. ${signInCommands.claude} before then to keep its threads working.`;
  }

  private refused(): string {
    switch (this.credential) {
      case "apiKey":
        return "Claude Code was refused the API key in the host's config.json (claude.apiKey). Put a working key there and restart the host, then try again.";
      case "oauthToken":
        return `Claude Code was refused the token in the host's config.json (claude.oauthToken). Make a new one with \`claude setup-token\` in a terminal on the ${machineWord()}, put it there and restart the host, then try again.`;
      case "login":
        if (this.endsAt !== null && this.endsAt <= this.now()) return `Claude Code's sign-in on this ${machineWord()} has ended. ${signInHint("claude")}`;
        return notSignedIn("claude");
    }
  }
}
