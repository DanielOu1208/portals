import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { AuthConfig } from "../config.ts";

// Sign-in the way the app does it against Hermes (docs/gateway-protocol.md, section 2):
// a password sign-in sets a session cookie; with that cookie the app asks for a ticket
// right before opening each WebSocket. A ticket works once, for 30 seconds. Sessions
// live in memory, so a restart signs everyone out and the app signs in again by itself.

// scrypt cost: 2^14 rounds, block size 8, one lane; about 50 ms and 16 MiB per check.
const cost = { N: 16384, r: 8, p: 1 };
const keyLength = 32;

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N, r, p, maxmem: 128 * N * r * 2 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** A hash to store in `config.json`: `scrypt$N$r$p$<salt>$<key>`, both base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, cost.N, cost.r, cost.p);
  return ["scrypt", cost.N, cost.r, cost.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Whether `password` matches `stored`. A malformed hash matches nothing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0) || salt.length === 0 || expected.length === 0) return false;
  try {
    const key = await derive(password, salt, N, r, p);
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Compares two strings without leaking where they differ, by comparing their digests. */
function sameText(a: string, b: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export type SignInOutcome =
  | { kind: "signedIn"; session: string }
  | { kind: "wrong" }
  | { kind: "unavailable" }
  | { kind: "limited" };

export interface AuthOptions {
  /** Read on every sign-in, so an edited config takes effect at the next one. */
  credentials: () => AuthConfig | null;
  now?: () => number;
  ticketLifetimeMs?: number;
  sessionLifetimeMs?: number;
  /** Failed sign-ins allowed per window before answering 429. */
  maxFailures?: number;
  failureWindowMs?: number;
}

export const sessionCookie = "aeriportal_session";

export class Auth {
  readonly ticketLifetimeMs: number;
  readonly sessionLifetimeMs: number;
  private readonly credentials: () => AuthConfig | null;
  private readonly now: () => number;
  private readonly maxFailures: number;
  private readonly failureWindowMs: number;
  /** Session token → when it stops working. */
  private readonly sessions = new Map<string, number>();
  private readonly tickets = new Map<string, number>();
  private failures: number[] = [];
  private checking = 0;

  constructor(options: AuthOptions) {
    this.credentials = options.credentials;
    this.now = options.now ?? Date.now;
    this.ticketLifetimeMs = options.ticketLifetimeMs ?? 30_000;
    this.sessionLifetimeMs = options.sessionLifetimeMs ?? 7 * 24 * 3600_000;
    this.maxFailures = options.maxFailures ?? 10;
    this.failureWindowMs = options.failureWindowMs ?? 60_000;
  }

  get isConfigured(): boolean {
    return this.credentials() !== null;
  }

  async signIn(username: string, password: string): Promise<SignInOutcome> {
    const credentials = this.credentials();
    if (!credentials) return { kind: "unavailable" };
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < this.failureWindowMs);
    if (this.failures.length + this.checking >= this.maxFailures) return { kind: "limited" };

    // Both checks always run, so a wrong user name takes as long as a wrong password.
    const nameMatches = sameText(username, credentials.username);
    // Reserve a place before scrypt yields: simultaneous attempts must share the limit too.
    this.checking += 1;
    let passwordMatches: boolean;
    try {
      passwordMatches = await verifyPassword(password, credentials.passwordHash);
    } finally {
      this.checking -= 1;
    }
    if (!nameMatches || !passwordMatches) {
      this.failures.push(this.now());
      return { kind: "wrong" };
    }
    const session = randomBytes(32).toString("hex");
    this.sessions.set(session, now + this.sessionLifetimeMs);
    return { kind: "signedIn", session };
  }

  /** Whether a `Cookie` header carries a session that still works. */
  hasSession(cookieHeader: string | undefined): boolean {
    const token = readCookie(cookieHeader, sessionCookie);
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  mintTicket(): string {
    this.dropExpiredTickets();
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, this.now() + this.ticketLifetimeMs);
    return ticket;
  }

  /** Uses up a ticket. True when it was valid; a ticket is never accepted twice. */
  takeTicket(ticket: string | null): boolean {
    if (!ticket) return false;
    const expires = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return expires !== undefined && expires > this.now();
  }

  private dropExpiredTickets(): void {
    const now = this.now();
    for (const [ticket, expires] of this.tickets) {
      if (expires <= now) this.tickets.delete(ticket);
    }
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
