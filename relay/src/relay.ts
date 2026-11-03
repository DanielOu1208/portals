import type { Apple } from "./apns.ts";
import { bundlePattern, deviceTokenPattern, issue, tokenKey, verify, type Environment } from "./tokens.ts";

// The relay's two routes (docs/pairing-and-relay.md), as a plain fetch handler: the
// Worker (src/worker.ts) hands it the key, the secrets and its rate limiters; the tests
// hand it stand-ins.
//
// - `POST /v1/devices`, from the app: a device token for a relay token.
// - `POST /v1/notify`, from a bridge with a relay token: one notification to that device.
// - `GET /v1/health`: that the relay is up, for checking a deploy.
//
// The relay stores nothing. It logs what it decided about each request (the route, the
// answer and Apple's reason), never a token, an address or a payload.

/** Counts requests by key; `success` is false once a key has had its share. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RelayOptions {
  /** The signing secrets: the first signs new relay tokens, any of them verifies one. */
  secrets: string[];
  /** The apps the relay sends for, by bundle ID. */
  bundleIDs: string[];
  apple: Apple;
  /** Registrations, keyed by the caller's address. None: no limit. */
  deviceLimit?: Limiter;
  /** Notifications, keyed by relay token. None: no limit. */
  notifyLimit?: Limiter;
  /** Unix seconds. */
  now?: () => number;
  log?: (line: string) => void;
}

/** The largest payload Apple takes for a notification, in bytes. */
export const payloadLimit = 4096;
/** The largest request body the relay reads. */
const bodyLimit = 8192;
/** How long Apple keeps trying a notification it could not deliver, when the bridge does not say. */
const defaultExpiry = 3600;

export function makeRelay(options: RelayOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => Date.now() / 1000);
  const log = options.log ?? ((line: string) => console.log(line));
  const allowed = new Set(options.bundleIDs);

  async function devices(request: Request): Promise<Response> {
    const address = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (options.deviceLimit && !(await options.deviceLimit.limit({ key: address })).success) return busy();
    const body = await jsonBody(request);
    if (!isObject(body)) return problem(400, "The body must be a JSON object.");
    const { token, environment, bundle_id: bundleID } = body;
    if (typeof token !== "string" || !deviceTokenPattern.test(token)) return problem(400, "token must be 32 to 200 hexadecimal characters.");
    if (environment !== "production" && environment !== "sandbox") return problem(400, 'environment must be "production" or "sandbox".');
    if (typeof bundleID !== "string" || !bundlePattern.test(bundleID)) return problem(400, "bundle_id must be 1 to 200 letters, digits, dots or dashes.");
    if (!allowed.has(bundleID)) return problem(403, "The relay does not send for this app.");
    const relayToken = await issue({ token, environment: environment as Environment, bundleID }, options.secrets[0], now());
    return json(200, { relay_token: relayToken });
  }

  async function notify(request: Request): Promise<Response> {
    const bearer = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    const device = bearer ? await verify(bearer, options.secrets) : null;
    // A token for an app the relay no longer sends for is turned away like a forged one.
    if (!device || !allowed.has(device.bundleID)) return problem(401, "The relay did not issue this token.");
    if (options.notifyLimit && !(await options.notifyLimit.limit({ key: tokenKey(bearer) })).success) return busy();

    const body = await jsonBody(request);
    if (!isObject(body)) return problem(400, "The body must be a JSON object.");
    const { payload, priority = 10, collapse_id: collapseID, expiration } = body;
    if (!isObject(payload) || !isObject(payload.aps)) return problem(400, "payload must be an APNs payload: a JSON object with aps.");
    const encoded = JSON.stringify(payload);
    if (new TextEncoder().encode(encoded).length > payloadLimit) return problem(400, "payload is over 4 KB.");
    if (priority !== 10 && priority !== 5 && priority !== 1) return problem(400, "priority must be 10, 5 or 1.");
    if (collapseID !== undefined && (typeof collapseID !== "string" || collapseID === "" || new TextEncoder().encode(collapseID).length > 64)) {
      return problem(400, "collapse_id must be a string of at most 64 bytes.");
    }
    if (expiration !== undefined && (!Number.isInteger(expiration) || (expiration as number) < 0)) {
      return problem(400, "expiration must be a whole number of seconds, 0 or more.");
    }

    const answer = await options.apple.send(
      {
        device,
        payload: encoded,
        priority,
        collapseID: collapseID as string | undefined,
        expiration: (expiration as number | undefined) ?? Math.floor(now()) + defaultExpiry,
      },
      now(),
    );
    switch (answer.outcome) {
      case "sent":
        return json(200, { sent: true });
      case "gone":
        log(`notify: gone (${answer.reason || "410"})`);
        return json(410, { gone: true });
      case "busy":
        log(`notify: Apple says too many (${answer.reason || "429"})`);
        return busy();
      case "failed":
        log(`notify: failed, Apple answered ${answer.status} ${answer.reason}`.trimEnd());
        return json(502, { sent: false, reason: answer.reason || `APNs answered ${answer.status}` });
    }
  }

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/v1/devices") return request.method === "POST" ? await devices(request) : notAllowed("POST");
      if (pathname === "/v1/notify") return request.method === "POST" ? await notify(request) : notAllowed("POST");
      if (pathname === "/v1/health") return request.method === "GET" ? json(200, { service: "portals-relay" }) : notAllowed("GET");
      return problem(404, "Not found.");
    } catch (error) {
      log(`${pathname}: ${(error as Error).name}`);
      return problem(500, "The relay failed.");
    }
  };
}

/** The request's body as JSON; undefined when it is not JSON or too long. */
async function jsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > bodyLimit) {
    await request.body?.cancel();
    return undefined;
  }
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(bodyLimit);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bodyLimit) {
        await reader.cancel();
        return undefined;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function problem(status: number, detail: string): Response {
  return json(status, { detail });
}

function busy(): Response {
  return json(429, { detail: "Too many requests; try again in a minute." }, { "retry-after": "60" });
}

function notAllowed(method: string): Response {
  return json(405, { detail: `Use ${method}.` }, { allow: method });
}
