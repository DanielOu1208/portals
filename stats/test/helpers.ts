import { generateKeyPairSync, sign } from "node:crypto";
import { makeAccess, type AccessCheck } from "../src/access.ts";
import { makeStats } from "../src/stats.ts";
import { testDatabase, testLimiter } from "./d1.ts";
import type { Limiter } from "../src/d1.ts";

// What the tests share: a server on the stand-ins, a day's body, and Access tokens signed
// with a key made here.

/** 2026-11-06 12:00 UTC. */
export const NOW = Date.parse("2026-11-06T12:00:00Z");
export const TEAM = "dana-team.cloudflareaccess.com";
export const AUD = "4f1d3b2a9c8e7d6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f";

export const INSTALL = "6f1c2b9e-4a7d-4d55-9c1e-2f0b7a8e3d41";
export const OWNER = "3b7e9c0d1a2f4e5b6c7d8e9f0a1b2c3d";

export function dayBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    install: INSTALL,
    owner: OWNER,
    day: "2026-11-05",
    version: "0.3.3",
    os: "darwin",
    turns: 42,
    portals: { iphone: 1, ipad: 0, mac: 1, other: 0 },
    usage: [
      { agent: "claude", model: "claude-opus-5-5", requests: 120, input: 2100, output: 51000, cache_read: 3900000, cache_write: 210000, reasoning: 0, usd: 12.34 },
    ],
    ...overrides,
  };
}

export function usageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { agent: "codex", model: "gpt-5.5-codex", requests: 10, input: 1000, output: 500, cache_read: 8000, cache_write: 0, reasoning: 200, usd: 0.5, ...overrides };
}

export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://stats.example/v1/day", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function get(path: string, token?: string): Request {
  return new Request(`https://stats.example${path}`, { headers: token ? { "cf-access-jwt-assertion": token } : {} });
}

export function server(options: { access?: AccessCheck | null; dayLimit?: Limiter; now?: () => number } = {}) {
  const db = testDatabase();
  const handle = makeStats({ db, access: options.access === undefined ? null : options.access, dayLimit: options.dayLimit ?? testLimiter(1000), now: options.now ?? (() => NOW) });
  return { db, handle };
}

// MARK: Access

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const KID = "dana-key-1";

/** The team's certs as Access publishes them, with the test key. */
export function certs(): { keys: unknown[] } {
  return { keys: [{ ...keyPair.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] };
}

/** An Access token: by default valid for TEAM and AUD at NOW, signed with the test key. */
export function token(options: { claims?: Record<string, unknown>; kid?: string; alg?: string; otherKey?: boolean } = {}): string {
  const seconds = Math.floor(NOW / 1000);
  const header = { alg: options.alg ?? "RS256", kid: options.kid ?? KID, typ: "JWT" };
  const claims = {
    aud: [AUD],
    email: "dana@example.com",
    exp: seconds + 3600,
    iat: seconds - 60,
    nbf: seconds - 60,
    iss: `https://${TEAM}`,
    sub: "dana-user-id",
    type: "app",
    ...options.claims,
  };
  const signed = `${part(header)}.${part(claims)}`;
  const signature = sign("sha256", Buffer.from(signed), (options.otherKey ? otherKeyPair : keyPair).privateKey);
  return `${signed}.${signature.toString("base64url")}`;
}

function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** The Access check for TEAM and AUD, with the certs served by a stand-in that counts its fetches. */
export function access(options: { now?: () => number } = {}) {
  const fetched: string[] = [];
  const check = makeAccess({
    teamDomain: TEAM,
    aud: AUD,
    now: options.now ?? (() => NOW),
    fetch: async (url) => {
      fetched.push(url);
      return Response.json(certs());
    },
  });
  return { check: check!, fetched };
}
