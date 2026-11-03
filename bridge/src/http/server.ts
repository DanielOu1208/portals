import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { counters, type HttpRoute } from "../counters.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { wellFormedJSON } from "../json.ts";
import { log } from "../log.ts";
import { NetRefused, type Net } from "../net/net.ts";
import type { PushStore } from "../push/store.ts";
import { sessionCookie, type Auth } from "./auth.ts";
import { handlePush } from "./push.ts";

// The bridge's HTTP side (docs/gateway-protocol.md, sections 2 and 10):
//
//   POST /auth/password-login                 sign in; sets the session cookie
//   POST /api/auth/ws-ticket                  a single-use ticket for one WebSocket
//   GET  /api/ws?ticket=…                     the WebSocket (4401 bad ticket, 4403 bad host)
//   GET  /api/ws, Authorization: Bearer …     the same, for a member of the net, with no ticket
//   POST /net/join                            joins the net with a code (docs/net-plan.md)
//   GET  /api/status                          a health check
//   PUT  /api/plugins/aeriportal-push/registration
//   DELETE /api/plugins/aeriportal-push/threads/{id}
//   GET  /api/plugins/aeriportal-push/status
//
// Every request must name an allowed host in its `Host` header, which keeps a web page
// from reaching the bridge through a name it controls (DNS rebinding).

export interface HttpOptions {
  auth: Auth;
  gateway: Gateway;
  push: PushStore;
  net: Net;
  allowedHosts: string[];
  version: string;
}

/** The largest frame the bridge reads; images arrive base64-encoded in one. */
const maxFrameBytes = 64 * 1024 * 1024;
const maxBodyBytes = 4 * 1024 * 1024;
const pushPrefix = "/api/plugins/aeriportal-push/";

/**
 * Frames of 1 KB or more go compressed (permessage-deflate) to a device that offers it,
 * as the app's URLSessionWebSocketTask does on every connection: the whole list is about
 * a sixth of its size, which on a slow phone link is most of a first connect.
 *
 * Each frame is compressed on its own (server_no_context_takeover): ws holds to the
 * threshold only then, so the small events most of a turn is made of go as they are,
 * with no zlib on the way, and a large frame loses little alone. Either way ws keeps a
 * compressor and a decompressor for the connection's life, about 360 KB once it
 * compressed something; what the device compresses is its own choice. zlib's own level:
 * the fastest sends a fifth more for a little over half the CPU.
 */
const compression = { threshold: 1024, serverNoContextTakeover: true };

export function createHttpServer(options: HttpOptions): Server {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes, perMessageDeflate: compression });
  const server = createServer((request, response) => {
    if (counters.on) {
      const started = performance.now();
      response.once("close", () => {
        if (counters.on) counters.http(routeWord(request), performance.now() - started, Number(request.headers["content-length"]) || 0, answered.get(response) ?? 0);
      });
    }
    route(request, response, options).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
      } else if (error instanceof BodyTooLarge) {
        send(response, 413, { detail: error.message });
      } else {
        log.error("request failed", { path: request.url?.split("?")[0], error: (error as Error)?.message });
        send(response, 500, { detail: "Something went wrong on the bridge." });
      }
    });
  });
  server.on("upgrade", (request, socket, head) => upgrade(request, socket, head, sockets, options));
  return server;
}

function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, sockets: WebSocketServer, options: HttpOptions): void {
  socket.on("error", (error) => log.debug("upgrade socket error", { error: error.message }));
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://bridge");
  } catch {
    // Unlike a routed request, an upgrade has no promise to catch a malformed target.
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  if (url.pathname !== "/api/ws") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    // Refused with a close code, not an HTTP status: the app reads the code.
    if (!hostAllowed(request.headers.host, options.allowedHosts) || !originAllowed(request.headers.origin, options.allowedHosts)) {
      log.warn("refused a WebSocket for its host or origin", { host: request.headers.host, origin: request.headers.origin });
      webSocket.close(4403, "This host or origin is not allowed.");
      return;
    }
    // A member of the net signs in with its token, and needs no ticket. Looking it up may
    // take a moment: a token the bridge does not know has it ask the other Macs first.
    const token = bearerToken(request.headers.authorization);
    if (token !== undefined) {
      options.net.authenticate(token).then(
        (member) => {
          if (webSocket.readyState !== webSocket.OPEN) return;
          if (member) options.gateway.accept(webSocket, member);
          else webSocket.close(4401, "The token was not accepted.");
        },
        (error: Error) => {
          log.error("could not check a token", { error: error.message });
          webSocket.close(4401, "The token was not accepted.");
        },
      );
      return;
    }
    // Otherwise the ticket is the only credential: the app opens the socket without its cookies.
    if (!options.auth.takeTicket(url.searchParams.get("ticket"))) {
      webSocket.close(4401, "The ticket was not accepted.");
      return;
    }
    options.gateway.accept(webSocket, { kind: "password" });
  });
}

/** The token of an `Authorization: Bearer <token>` header; undefined for none. */
function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1] : undefined;
}

async function route(request: IncomingMessage, response: ServerResponse, options: HttpOptions): Promise<void> {
  if (!hostAllowed(request.headers.host, options.allowedHosts)) {
    send(response, 403, { detail: "This host name is not allowed." });
    return;
  }
  const url = new URL(request.url ?? "/", "http://bridge");
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (path === "/auth/password-login" && method === "POST") {
    const body = await readJSONBody(request);
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const outcome = await options.auth.signIn(username, password);
    switch (outcome.kind) {
      case "signedIn": {
        const maxAge = Math.floor(options.auth.sessionLifetimeMs / 1000);
        response.setHeader("Set-Cookie", `${sessionCookie}=${outcome.session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`);
        send(response, 200, { ok: true });
        return;
      }
      case "wrong":
        send(response, 401, { detail: "The user name or password is wrong." });
        return;
      case "unavailable":
        send(response, 404, { detail: "No password is set up on this bridge." });
        return;
      case "limited":
        send(response, 429, { detail: "Too many sign-in attempts. Try again in a minute." });
        return;
    }
  }

  if (path === "/api/auth/ws-ticket" && method === "POST") {
    if (!options.auth.hasSession(request.headers.cookie)) {
      send(response, 401, { detail: "Sign in first." });
      return;
    }
    send(response, 200, { ticket: options.auth.mintTicket(), ttl_seconds: Math.floor(options.auth.ticketLifetimeMs / 1000) });
    return;
  }

  if (path === "/net/join" && method === "POST") {
    // No sign-in: the code is the credential, and too many wrong ones are refused for a minute.
    const body = await readJSONBody(request);
    try {
      send(response, 200, options.net.join(body));
    } catch (error) {
      if (!(error instanceof NetRefused)) throw error;
      send(response, error.status, { detail: error.message });
    }
    return;
  }

  if (path === "/api/status" && method === "GET") {
    send(response, 200, { status: "ok", service: "portals-bridge", version: options.version });
    return;
  }

  if (path.startsWith(pushPrefix)) {
    // A member of the net signs in with its token here too; its registration is kept under its id.
    const token = bearerToken(request.headers.authorization);
    const member = token !== undefined ? await options.net.authenticate(token) : undefined;
    if (token !== undefined ? !member || member.removed : !options.auth.hasSession(request.headers.cookie)) {
      send(response, 401, { detail: token !== undefined ? "The token was not accepted." : "Sign in first." });
      return;
    }
    const readsBody = method === "PUT" || (method === "DELETE" && /^threads\/[^/]+\/watcher$/.test(path.slice(pushPrefix.length)));
    const body = readsBody ? await readJSONBody(request) : undefined;
    // The body may come long after the token was checked: a member removed meanwhile changes nothing.
    if (token !== undefined) {
      const still = options.net.known(token);
      if (!still || still.removed || still.id !== member!.id) {
        send(response, 401, { detail: "The token was not accepted." });
        return;
      }
    }
    const answer = handlePush(options.push, method, path.slice(pushPrefix.length), body, member?.id);
    if (answer) {
      send(response, answer.status, answer.body);
      return;
    }
  }

  send(response, 404, { detail: "Not found." });
}

/** The `Host` header's name, without its port or IPv6 brackets, lower case. */
function hostName(header: string): string | undefined {
  try {
    return new URL(`http://${header}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined;
  }
}

export function hostAllowed(header: string | undefined, allowed: string[]): boolean {
  if (!header) return false;
  const name = hostName(header);
  return name !== undefined && allowed.includes(name);
}

/** No `Origin` is fine (the app sends none); one from a web page must name an allowed host. */
function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (origin === undefined) return true;
  try {
    return hostAllowed(new URL(origin).host, allowed);
  } catch {
    return false;
  }
}

class BodyTooLarge extends Error {}

/** The body as a JSON object; undefined when it is empty or not JSON. */
async function readJSONBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBodyBytes) throw new BodyTooLarge("The request body is too large.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  // As a gateway frame is: the app reads `/net/join`'s answer with the same decoder.
  const text = wellFormedJSON(body);
  const bytes = Buffer.byteLength(text);
  if (counters.on) answered.set(response, bytes);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes,
    "Cache-Control": "no-store",
  });
  response.end(text);
}

/** While the counters are on: the bytes of each answer's body, until its request is counted. */
const answered = new WeakMap<ServerResponse, number>();

/** Which route a request is for, as one of five words: a path can carry a thread's id. */
function routeWord(request: IncomingMessage): HttpRoute {
  const path = (request.url ?? "/").split("?")[0];
  if (path === "/auth/password-login") return "login";
  if (path === "/api/auth/ws-ticket") return "ticket";
  if (path === "/api/status") return "status";
  return path.startsWith(pushPrefix) ? "push" : "other";
}
