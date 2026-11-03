import { statSync } from "node:fs";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { counters } from "../counters.ts";
import { callOnce, CallTimeout, GatewayError, HungUp, type CallBytes, type CallFallback, type CallReady, type CallReceiver } from "../gateway/call.ts";
import { ErrorCode, RpcError } from "../gateway/errors.ts";
import { computerName, machineWord } from "../platform.ts";
import { readJSON, writeJSON } from "../store/jsonFile.ts";

// Offer the gateway's 1 KB, no-context compression policy; older peers may decline.
// These sockets last for one RPC, so no compression state is retained between calls.
const linkCompression = { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true };

// Links to other Macs (docs/fleet-plan.md): the bridges this one can reach as a client,
// to list their threads beside its own and to pass on calls for them.
//
// Most links follow from the net (docs/net-plan.md): every other Mac in it is one,
// named after the Mac, and a call to it opens a WebSocket with this Mac's own token,
// asks and hangs up, with no sign-in and no ticket. Both Macs are in each other's list,
// so they reach each other both ways.
//
// A link made by hand is the other bridge's address and sign-in, as its pairing link
// gives them (docs/pairing-and-relay.md), kept in `links.json` in the bridge's folder,
// owner only. The other bridge sees one more client that signed in with its password,
// as the app does: each call signs in (once, the session is kept), takes a ticket,
// opens a WebSocket, asks and hangs up. Such a link gives reach one way. One whose name
// or address a Mac of the net has is left out: the net's link is that Mac.

/** A link made by hand, kept in `links.json`. */
export interface Link {
  /** What the other Mac is called here: the first part of `machine/thread`. Lower case letters, digits and dashes. */
  name: string;
  /** The address the other bridge answers at, with scheme and port. */
  url: string;
  user: string;
  password: string;
}

/** Another Mac of the net, reached with this Mac's own token. */
export interface NetLink {
  name: string;
  url: string;
  net: true;
}

/** A bridge reached with a token: what a call to another Mac of the net is made with. */
export interface TokenLink {
  name: string;
  url: string;
  token: string;
}

/** What the net says of its other Macs, for the links that follow from it. */
export interface NetMacs {
  /** The other Macs in the net, not removed and with an address, in the list's order, each with its stable id. */
  macs(): { id?: string; name: string; url: string }[];
  /** This Mac's own token, which they know it by. */
  token(): string;
}

/**
 * A linked Mac's bridge could not be used: a sentence ending "Could not reach mini: …".
 * `refused` when it did not take the sign-in, and `busy` when it had had too many
 * failed ones: asking again soon would only count against its limit.
 */
export class LinkError extends Error {
  readonly kind: "refused" | "busy" | undefined;

  constructor(message: string, kind?: "refused" | "busy") {
    super(message);
    this.kind = kind;
  }
}

/** Internal marker; the public timeout code and sentence are unchanged. */
export class LinkTimeout extends RpcError {}

/**
 * This Mac's network host name, without `.local`: what older bridges named it by in a
 * message passed on to another Mac, and still the first part of the origin a thread
 * started on another Mac keeps (`StartedBy.origin`). It changes with the network (a
 * DHCP name on a campus Wi-Fi), so no one is shown it: they are shown `macName`.
 */
export function thisMachine(): string {
  return hostname().replace(/\.local$/, "");
}

let named: string | undefined;

/**
 * This machine's name as people know it: `fleet.name` in the bridge's config when given,
 * else its own name (a Mac's Computer Name, "a Mac mini", or Linux's pretty host
 * name; read once), else its host name.
 */
export function macName(configured?: string | null): string {
  if (configured) return configured;
  named ??= computerName();
  return named || thisMachine();
}

/** A name for a machine as links keep it: lower case letters, digits and dashes. */
export function machineName(text: string): string {
  return text
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** What a pairing link (`portals://pair?v=1&url=…&user=…&password=…&name=…`) says. */
export function parsePairingLink(text: string): { url: string; user: string; password: string; name?: string } {
  let link: URL;
  try {
    link = new URL(text.trim());
  } catch {
    throw new LinkError("That is not a pairing link. `npx portals-host pair` on the other Mac shows one; it starts with portals://pair.");
  }
  if (link.protocol !== "portals:" || link.hostname !== "pair") {
    throw new LinkError("That is not a pairing link. `npx portals-host pair` on the other Mac shows one; it starts with portals://pair.");
  }
  if (Number(link.searchParams.get("v") ?? "1") > 1) throw new LinkError(`That pairing link is from a newer bridge than this one. Update this ${machineWord()}'s bridge first.`);
  const url = link.searchParams.get("url") ?? "";
  const user = link.searchParams.get("user") ?? "";
  const password = link.searchParams.get("password") ?? "";
  if (!/^https?:\/\//.test(url) || user === "" || password === "") throw new LinkError("That pairing link is missing the other Mac's address, user name or password.");
  const name = link.searchParams.get("name") ?? undefined;
  return name ? { url, user, password, name } : { url, user, password };
}

export function readLinks(path: string): Link[] {
  const stored = readJSON<{ links?: unknown }>(path, {});
  if (!Array.isArray(stored.links)) return [];
  return stored.links.filter(
    (link): link is Link =>
      typeof link === "object" && link !== null && ["name", "url", "user", "password"].every((key) => typeof (link as Record<string, unknown>)[key] === "string" && (link as Record<string, unknown>)[key] !== ""),
  );
}

/** Writes the links, in a file only its owner can read: it holds the other bridges' passwords. */
export function writeLinks(path: string, links: Link[]): void {
  writeJSON(path, { links });
}

/** How long a call to another Mac may take when it waits for nothing. */
export const linkCallMs = 30_000;
/** How long a Mac that did not answer a listing is left out of the next ones: it is likely asleep. */
const downMs = 30_000;
/** How long a sign-in a Mac refused is not tried again, unless the link changes: each try counts against its limit. */
const refusedMs = 10 * 60_000;
/** How long after a Mac said it had had too many failed sign-ins. */
const busyMs = 60_000;

export interface LinkCallOptions {
  /** Hangs up early, for a caller who stopped waiting. */
  signal?: AbortSignal;
  /** Only a look (a list of threads or agents): a Mac that failed a moment ago is not asked again yet. */
  glance?: boolean;
  fallback?: CallFallback;
  receive?: CallReceiver;
  ready?: CallReady;
}

export class Links {
  private readonly path: string;
  private readonly net: NetMacs | undefined;
  private links: Link[] = [];
  /** When the file last changed, as far as this has read it. */
  private readAt = -1;
  /** The net's Macs as last listed, as one text, to tell when they changed. */
  private netSeen = "";
  /** The links as `all` last gave them. */
  private current: (Link | NetLink)[] = [];
  /** By link name: the session cookie the other bridge gave. */
  private readonly sessions = new Map<string, string>();
  /** By link name: until when it is not asked, and why. */
  private readonly resting = new Map<string, { until: number; error: Error; glanceOnly: boolean }>();
  /**
   * By link made by hand: the sign-in under way, whose session or refusal the calls that
   * need one meanwhile take (`callLink`): each sign-in tried counts against the other
   * bridge's limit, which the person's phone shares.
   */
  private readonly signIns = new WeakMap<Link, Promise<string>>();

  /** `net`: the net whose other Macs are links too; without it, only the file's. */
  constructor(path: string, net?: NetMacs) {
    this.path = path;
    this.net = net;
  }

  /**
   * The net's other Macs, then the file's links whose name and address none of them
   * has. The file is read again whenever it has changed, and the net asked every time.
   */
  all(): (Link | NetLink)[] {
    let changed = 0;
    try {
      changed = statSync(this.path).mtimeMs;
    } catch {
      // No file: no links.
    }
    const macs = this.net?.macs() ?? [];
    const seen = JSON.stringify(macs);
    if (changed === this.readAt && seen === this.netSeen) return this.current;
    if (changed !== this.readAt) {
      this.readAt = changed;
      this.links = changed === 0 ? [] : readLinks(this.path);
    }
    this.netSeen = seen;
    this.sessions.clear();
    this.resting.clear();
    const fromNet = netLinks(macs);
    const taken = new Set(fromNet.flatMap((link) => [link.name, link.url]));
    const byHand = this.links.filter((link) => !taken.has(link.name) && !taken.has(link.url));
    this.current = [...fromNet.map((link): NetLink => ({ ...link, net: true })), ...byHand];
    return this.current;
  }

  /** Whether a glance at `name` would be turned away now, unasked, for failing a moment ago. */
  isResting(name: string): boolean {
    return (this.resting.get(name)?.until ?? 0) > Date.now();
  }

  get(name: string): Link | NetLink | undefined {
    return this.all().find((link) => link.name === name);
  }

  /** The name of the link to the net's Mac whose stable id is `machine` (`state/machine.json`), when the net has it. */
  nameOfMachine(machine: string): string | undefined {
    const macs = this.net?.macs() ?? [];
    const index = macs.findIndex((mac) => mac.id === machine);
    return index < 0 ? undefined : netLinks(macs)[index]?.name;
  }

  /**
   * One call to the bridge of the linked Mac `name`. Its refusals come back as they
   * are; a Mac that cannot be reached, or does not take the sign-in, is an error with a
   * sentence saying so.
   */
  async call(name: string, method: string, params: Record<string, unknown>, timeoutMs = linkCallMs, options: LinkCallOptions = {}): Promise<unknown> {
    const link = this.get(name);
    if (!link) throw new RpcError(ErrorCode.notFound, `There is no linked Mac called ${name}.`);
    const resting = this.resting.get(name);
    if (resting && resting.until > Date.now() && (options.glance || !resting.glanceOnly)) throw resting.error;
    // Counted by the link's place in the list (the net's Macs, then the file's), never by its name.
    const started = counters.on ? performance.now() : 0;
    const bytes: CallBytes | undefined = started ? { out: 0, in: 0, signins: 0 } : undefined;
    const place = started ? this.current.indexOf(link) : -1;
    // A call that waits for a thread on purpose: its time is kept apart.
    const waits = method === "thread.wait" || params.wait === true;
    try {
      // The token is read at each call: it changes when this Mac starts a net of its own.
      const reached = "net" in link ? { name: link.name, url: link.url, token: this.net?.token() ?? "" } : link;
      const answer = await callLink(reached, method, params, timeoutMs, this.sessions, options.signal, bytes, options.fallback, options.receive, this.signIns, options.ready);
      if (this.isCurrent(name, link)) this.resting.delete(name);
      if (bytes) counters.linked(place, performance.now() - started, bytes.out, bytes.in, bytes.signins, false, waits);
      return answer;
    } catch (error) {
      if (bytes) counters.linked(place, performance.now() - started, bytes.out, bytes.in, bytes.signins, true, waits);
      // Called off by whoever asked: theirs to say why.
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof GatewayError) {
        // Its bridge answered, if with a refusal: it is there, and listings ask it again.
        if (this.isCurrent(name, link)) this.resting.delete(name);
        if (error.code === ErrorCode.methodNotFound) throw new RpcError(ErrorCode.internal, `The bridge on ${name} is too old for this. Update it.`);
        throw new RpcError(error.code, error.message);
      }
      const Failure = error instanceof CallTimeout ? LinkTimeout : RpcError;
      const failure = new Failure(ErrorCode.internal, `Could not reach ${name}: ${whyNot(error)}`);
      // A link changed while the call was under way: what came of it says nothing of the link as it is now.
      if (!this.isCurrent(name, link)) throw failure;
      // A refused or busy sign-in is not tried again for a while, by any call: each try
      // counts against the other bridge's limit, which locks out the person's phone too.
      // A Mac that did not answer is left out of listings for a moment: it is likely asleep.
      if (error instanceof LinkError && error.kind === "refused") this.resting.set(name, { until: Date.now() + refusedMs, error: failure, glanceOnly: false });
      else if (error instanceof LinkError && error.kind === "busy") this.resting.set(name, { until: Date.now() + busyMs, error: failure, glanceOnly: false });
      else if (!(error instanceof LinkError)) this.resting.set(name, { until: Date.now() + downMs, error: failure, glanceOnly: true });
      throw failure;
    }
  }

  /** Observe immediate listing backoff without bypassing it on the app path. */
  listingBackoff(name: string): Error | undefined {
    const resting = this.resting.get(name);
    return resting?.glanceOnly && resting.until > Date.now() ? resting.error : undefined;
  }

  /** Whether `link` is still the link called `name`: the file or the net may have changed since a call to it began. */
  private isCurrent(name: string, link: Link | NetLink): boolean {
    return this.get(name) === link;
  }
}

/** What `promise` comes to, unless `signal` is aborted first (or already): then its reason. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/** The net's Macs as links, each named after its Mac; a name two of them would have gets `-2`, `-3`, … after the first. */
export function netLinks(macs: { name: string; url: string }[]): { name: string; url: string }[] {
  const used = new Set<string>();
  return macs.map((mac) => {
    const base = machineName(mac.name) || "mac";
    let name = base;
    for (let count = 2; used.has(name); count += 1) name = `${base}-${count}`;
    used.add(name);
    return { name, url: mac.url };
  });
}

/** The WebSocket of a bridge at `base`, opened with `token`: no sign-in and no ticket. */
export function openWithToken(base: string, token: string): WebSocket {
  return new WebSocket(`${base.replace(/\/+$/, "").replace(/^http/, "ws")}/api/ws`, { headers: { Authorization: `Bearer ${token}` }, perMessageDeflate: linkCompression, maxPayload: 64 * 1024 * 1024 });
}

/**
 * One call to a linked bridge. Another Mac of the net is reached with this Mac's token.
 * A link made by hand signs in the way the app does (docs/gateway-protocol.md, section
 * 2): `sessions` keeps the cookie from one call to the next; a session the other bridge
 * no longer knows (it restarted) is signed in again, once.
 */
export async function callLink(link: Link | TokenLink, method: string, params: Record<string, unknown>, timeoutMs: number, sessions = new Map<string, string>(), signal?: AbortSignal, bytes?: CallBytes, fallback?: CallFallback, receive?: CallReceiver, signIns?: WeakMap<Link, Promise<string>>, ready?: CallReady): Promise<unknown> {
  const base = link.url.replace(/\/+$/, "");
  if ("token" in link) return callOnce(() => openWithToken(base, link.token), method, params, timeoutMs, signal, bytes, fallback, receive, ready);
  // One budget for the whole call: signing in, the ticket and the call itself.
  const ends = Date.now() + timeoutMs;
  const deadline = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
  // A sign-in other calls may take has a time of its own, not its first caller's.
  const signingIn = signIns ? AbortSignal.timeout(Math.max(timeoutMs, linkCallMs)) : deadline;

  /**
   * What a request's body weighs, counted as it is handed over, as the call's own frame
   * is (gateway/call.ts): the other Mac may have had all of it when the answer never comes.
   */
  const sending = (body: string) => {
    if (bytes) bytes.out += Buffer.byteLength(body);
  };
  /** What an answer's body weighs, as the other bridge said it. */
  const weigh = (response: Response) => {
    if (bytes) bytes.in += Number(response.headers.get("content-length")) || 0;
  };

  const signIn = async (): Promise<string> => {
    // Its own time and no caller's signal: other calls may be taking this sign-in, each within its own (`signedIn`).
    const body = JSON.stringify({ provider: "basic", username: link.user, password: link.password });
    sending(body);
    // A sign-in tried, whatever comes of it.
    if (bytes) bytes.signins += 1;
    const response = await fetch(`${base}/auth/password-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      signal: signingIn,
    });
    weigh(response);
    if (response.status === 401) throw new LinkError("it did not take the user name and password. Link it again with a new pairing link.", "refused");
    if (response.status === 404) throw new LinkError("it has no password set up. Run npx portals-host setup there.");
    if (response.status === 429) throw new LinkError("it has had too many failed sign-ins. Try again in a minute.", "busy");
    if (response.status === 403) throw new LinkError("it refused this address. Its allowedHosts must name the address in the link.");
    // tailscale serve answers for a bridge that is not running.
    if (response.status === 502 || response.status === 503 || response.status === 504) throw new LinkError("that Mac answers, but its bridge does not. Is the bridge running there?");
    if (response.status !== 200) throw new LinkError(`its sign-in answered ${response.status}.`);
    const cookie = response.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
    if (cookie === "") throw new LinkError("its sign-in gave no session.");
    sessions.set(link.name, cookie);
    return cookie;
  };

  const ticket = async (cookie: string): Promise<string | null> => {
    sending("{}");
    const response = await fetch(`${base}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{}",
      signal: deadline,
    });
    weigh(response);
    if (response.status === 401 || response.status === 403) return null;
    if (response.status !== 200) throw new LinkError(`its ticket route answered ${response.status}.`);
    const body = (await response.json()) as { ticket?: unknown };
    if (typeof body.ticket !== "string" || body.ticket === "") throw new LinkError("it gave no ticket.");
    return body.ticket;
  };

  /**
   * One sign-in at a time for the link (`signIns`, the caller's): a call that needs one
   * while another is under way, its session refused by a bridge that restarted too, takes
   * that one's session or refusal, within its own time and signal.
   */
  const signedIn = (): Promise<string> => {
    let pending = signIns?.get(link);
    if (!pending) {
      const started = signIn();
      pending = started;
      signIns?.set(link, started);
      const done = () => {
        if (signIns?.get(link) === started) signIns.delete(link);
      };
      started.then(done, done);
    }
    return until(pending, deadline);
  };

  const known = sessions.get(link.name);
  const granted = (known ? await ticket(known) : null) ?? (await ticket(await signedIn()));
  if (granted === null) {
    sessions.delete(link.name);
    throw new LinkError("it did not accept the sign-in it had just given.");
  }
  const address = `${base.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(granted)}`;
  return callOnce(() => new WebSocket(address, { perMessageDeflate: linkCompression, maxPayload: 64 * 1024 * 1024 }), method, params, Math.max(ends - Date.now(), 1), signal, bytes, fallback, receive, ready);
}

/** Why a call to another Mac failed, as the end of "Could not reach mini: …". */
export function whyNot(error: unknown): string {
  if (error instanceof LinkError) return error.message;
  if (error instanceof HungUp) {
    if (error.code === 4401) return "it did not accept the sign-in.";
    return "it hung up before answering.";
  }
  const failure = error as Error & { cause?: { code?: string; message?: string }; code?: string };
  if (failure.name === "TimeoutError" || failure.name === "AbortError") return "it did not answer in time. Is that Mac awake, and its bridge running?";
  const code = failure.cause?.code ?? failure.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ETIMEDOUT" || code === "ECONNRESET") {
    return "nothing answers at its address. Is that Mac awake, and its bridge running?";
  }
  return `${failure.cause?.message ?? failure.message}.`.replace(/\.\.$/, ".");
}
