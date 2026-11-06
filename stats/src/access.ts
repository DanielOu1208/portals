// Cloudflare Access in front of the page. Access signs in the maintainer and adds a token
// to each request it lets through, `Cf-Access-Jwt-Assertion`: a JWT signed with RS256 by
// the team's keys, published at https://<team>/cdn-cgi/access/certs. The Worker checks
// that token itself (signature, issuer, the application's AUD, its times) rather than
// trusting that Access sits in front, so the page stays closed if Access is ever taken off
// or the Worker is reached another way. Headers such as an email that Access also sets are
// never trusted alone: anyone can send them.

export interface AccessOptions {
  /** The team's domain, "<team>.cloudflareaccess.com" (a leading https:// is allowed). */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
  /** Milliseconds since 1970. */
  now?: () => number;
  /** How the team's keys are fetched: the Worker's fetch, a stand-in in the tests. */
  fetch?: (url: string) => Promise<Response>;
}

/** Whether a request carries a token Access issued for this application, still valid. */
export type AccessCheck = (request: Request) => Promise<boolean>;

type VerifyKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const hostPattern = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** The longest token read; Access's are about a kilobyte. */
const tokenLimit = 8192;
/** How long the team's keys are used before they are fetched again. Access rotates them every few weeks. */
const keysLifetime = 60 * 60_000;
/** A token naming a key not yet known fetches the keys again, but not more often than this. */
const refetchGap = 30_000;
/** Clock difference allowed for a token's start (nbf, iat): never for its end. */
const skew = 60;

/**
 * The check for one team and application, or null when `teamDomain` is not a host name or
 * either is empty: then nothing but POST /v1/day is let through (src/stats.ts).
 */
export function makeAccess(options: AccessOptions): AccessCheck | null {
  const team = options.teamDomain.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  const aud = options.aud.trim();
  if (!hostPattern.test(team) || !aud) return null;
  const issuer = `https://${team}`;
  const now = options.now ?? Date.now;
  const fetchKeys = options.fetch ?? ((url: string) => fetch(url));

  let keys = new Map<string, VerifyKey>();
  let fetchedAt = -Infinity;
  let fetching: Promise<void> | null = null;

  async function load(): Promise<void> {
    fetching ??= (async () => {
      try {
        const response = await fetchKeys(`${issuer}/cdn-cgi/access/certs`);
        if (!response.ok) return;
        const body = (await response.json()) as { keys?: unknown };
        const loaded = new Map<string, VerifyKey>();
        for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
          if (!isObject(jwk) || jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
          try {
            const { kid, kty, n, e } = jwk as { kid: string; kty: string; n: string; e: string };
            loaded.set(kid, await crypto.subtle.importKey("jwk", { kty, n, e }, algorithm, false, ["verify"]));
          } catch {
            // A key Node or the Worker cannot read is left out; the others still work.
          }
        }
        keys = loaded;
        fetchedAt = now();
      } catch {
        // Unreachable for now: the keys held so far stay, and the next request tries again.
      } finally {
        fetching = null;
      }
    })();
    return fetching;
  }

  async function key(kid: string): Promise<VerifyKey | undefined> {
    const age = now() - fetchedAt;
    if (age > keysLifetime || (!keys.has(kid) && age > refetchGap)) await load();
    return keys.get(kid);
  }

  return async (request) => {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token || token.length > tokenLimit) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = jsonPart(parts[0]);
    const claims = jsonPart(parts[1]);
    const signature = bytes(parts[2]);
    if (!header || !claims || !signature) return false;
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;

    const seconds = now() / 1000;
    if (claims.iss !== issuer) return false;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(aud)) return false;
    if (typeof claims.exp !== "number" || seconds >= claims.exp) return false;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > seconds + skew)) return false;
    if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat > seconds + skew)) return false;

    const verifier = await key(header.kid);
    if (!verifier) return false;
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return crypto.subtle.verify(algorithm, verifier, signature, signed);
  };
}

function jsonPart(part: string): Record<string, unknown> | null {
  const decoded = bytes(part);
  if (!decoded) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** The bytes a base64url part holds, or null when it is not base64url. */
function bytes(part: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1) return null;
  const binary = atob(part.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
