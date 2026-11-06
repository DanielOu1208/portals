import type { AccessCheck } from "./access.ts";
import type { D1Database, Limiter } from "./d1.ts";
import { utcDay } from "./dates.ts";
import { parseDay, writeDay } from "./day.ts";
import { page } from "./page.ts";
import { longestRange, summary } from "./summary.ts";

// The stats Worker's routes, as a plain fetch handler: the Worker (src/worker.ts) hands it
// D1, its rate limiter and the Access check; the tests hand it stand-ins.
//
// - `POST /v1/day`, from a host: one day of its anonymous totals (src/day.ts). Open to all.
// - `GET /`: the page (src/page.ts), and `GET /api/summary?days=N`, its data. Only with a
//   valid Cloudflare Access token; with no Access check set up, never.
//
// Nothing is logged. The caller's address is only the rate limiter's key: it is not
// stored, and no answer repeats anything of what was sent.

export interface StatsOptions {
  db: D1Database;
  /** Days sent, keyed by the caller's address. None: no limit. */
  dayLimit?: Limiter;
  /** Null while Access is not set up: then only POST /v1/day is answered. */
  access: AccessCheck | null;
  /** Milliseconds since 1970. */
  now?: () => number;
}

/** The largest body read: 64 usage rows at their longest fit with room to spare. */
export const bodyLimit = 32_768;

const notADay = "Not a day of Portals totals.";

export function makeStats(options: StatsOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;

  async function day(request: Request): Promise<Response> {
    const address = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (options.dayLimit && !(await options.dayLimit.limit({ key: address })).success) {
      await request.body?.cancel();
      return json(429, { detail: "Too many requests; try again in a minute." }, { "retry-after": "60" });
    }
    const body = await jsonBody(request);
    if (body === tooLong) return problem(413, "The body is too long.");
    const received = now();
    const parsed = parseDay(body, utcDay(received));
    if (!parsed) return problem(400, notADay);
    await writeDay(options.db, parsed, received);
    return new Response(null, { status: 204 });
  }

  async function data(url: URL): Promise<Response> {
    const asked = url.searchParams.get("days") ?? "30";
    const days = /^\d{1,3}$/.test(asked) ? Number(asked) : 0;
    if (days < 1 || days > longestRange) return problem(400, `days is 1 to ${longestRange}.`);
    return json(200, await summary(options.db, days, utcDay(now())), { "cache-control": "no-store" });
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/v1/day" && request.method === "POST") return await day(request);
      // Everything else is the maintainer's: no route, not even which exist, is told to anyone else.
      if (!options.access || !(await options.access(request))) {
        await request.body?.cancel();
        return problem(403, "Forbidden.");
      }
      if (url.pathname === "/") return request.method === "GET" ? html(page) : notAllowed("GET");
      if (url.pathname === "/api/summary") return request.method === "GET" ? await data(url) : notAllowed("GET");
      if (url.pathname === "/v1/day") return notAllowed("POST");
      return problem(404, "Not found.");
    } catch {
      return problem(500, "The stats server failed.");
    }
  };
}

const tooLong = Symbol("too long");

/** The request's body as JSON; undefined when it is not JSON, `tooLong` past `bodyLimit`. */
async function jsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > bodyLimit) {
    await request.body?.cancel();
    return tooLong;
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
        return tooLong;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch {
    return undefined;
  }
}

// The page and its data are one person's: never kept by a browser or a cache on the way,
// never framed, and the page reaches nothing but this Worker.
const privateHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      ...privateHeaders,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...privateHeaders, "content-type": "application/json", ...headers } });
}

function problem(status: number, detail: string): Response {
  return json(status, { detail });
}

function notAllowed(method: string): Response {
  return json(405, { detail: `Use ${method}.` }, { allow: method });
}
