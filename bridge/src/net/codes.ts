import { randomBytes } from "node:crypto";

// Join codes (docs/net-plan.md): what a member of the net shows another device or Mac
// to let it in, inside a `portals://join` link. A code is the only credential
// `POST /net/join` takes, so it works once, for ten minutes, and lives in memory only:
// a restart forgets every code. It lets in to the net it was made in only: the Mac
// drops every open code when it moves to another net (`clear`). At most twenty are open; making one more lets go of the
// oldest. Ten wrong codes in a minute and the route refuses every code for the rest of
// that minute, as sign-in does after ten wrong passwords.

export interface JoinCodesOptions {
  now?: () => number;
  lifetimeMs?: number;
  /** How many codes may be open at once. */
  most?: number;
  /** Wrong codes allowed per window before every code is refused. */
  maxFailures?: number;
  failureWindowMs?: number;
}

/** What a code given to `/net/join` is: one to take, one that is not, or one not looked at for the failures before it. */
export type CodeCheck = "valid" | "wrong" | "limited";

export class JoinCodes {
  readonly lifetimeMs: number;
  private readonly now: () => number;
  private readonly most: number;
  private readonly maxFailures: number;
  private readonly failureWindowMs: number;
  /** Code → when it stops working and the net it was made in, oldest first. */
  private readonly codes = new Map<string, { expires: number; net: string }>();
  private failures: number[] = [];

  constructor(options: JoinCodesOptions = {}) {
    this.now = options.now ?? Date.now;
    this.lifetimeMs = options.lifetimeMs ?? 10 * 60_000;
    this.most = options.most ?? 20;
    this.maxFailures = options.maxFailures ?? 10;
    this.failureWindowMs = options.failureWindowMs ?? 60_000;
  }

  /** A new code for the net `net`: 16 random bytes in base64url, and when it stops working. */
  issue(net: string): { code: string; expiresAt: number } {
    this.dropExpired();
    while (this.codes.size >= this.most) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(16).toString("base64url");
    const expiresAt = this.now() + this.lifetimeMs;
    this.codes.set(code, { expires: expiresAt, net });
    return { code, expiresAt };
  }

  /**
   * Whether `code` can be taken into the net `net`, without taking it. A code that cannot
   * counts as a failure; once there were too many in the window, every code is `limited`.
   */
  check(code: unknown, net: string): CodeCheck {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < this.failureWindowMs);
    if (this.failures.length >= this.maxFailures) return "limited";
    const open = typeof code === "string" ? this.codes.get(code) : undefined;
    if (open !== undefined && open.expires > now && open.net === net) return "valid";
    this.failures.push(now);
    return "wrong";
  }

  /** Uses up a code. True when it was valid; a code is never taken twice. */
  take(code: string): boolean {
    const open = this.codes.get(code);
    this.codes.delete(code);
    return open !== undefined && open.expires > this.now();
  }

  /** Lets go of every open code: the Mac is in another net now. */
  clear(): void {
    this.codes.clear();
  }

  /** How many codes are open. */
  get open(): number {
    this.dropExpired();
    return this.codes.size;
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [code, open] of this.codes) {
      if (open.expires <= now) this.codes.delete(code);
    }
  }
}
