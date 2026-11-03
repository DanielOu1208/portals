import { randomUUID } from "node:crypto";
import { SettingRefused } from "../types.ts";
import { mcpAuthDeadlineMs, McpAuthSettling, type McpAuthAction, type McpAuthCard } from "../mcpAuth.ts";
import type { DroidHandle } from "./sdk.ts";

interface Attempt {
  card: McpAuthCard;
  state?: string;
  timer?: NodeJS.Timeout;
  submitting?: boolean;
  settled?: boolean;
  cancellation?: Promise<void>;
  stopFailed?: boolean;
  hidden?: boolean;
  requiredByNotification?: boolean;
}

/** OAuth material lives only here; events carry an invalidation, never this state. */
export class DroidMcpAuth {
  private readonly attempts = new Map<string, Attempt>();
  private generation = 0;
  /** Any newer lookup or auth transition makes an older metadata snapshot obsolete. */
  private revision = 0;
  private readonly changed: () => void;
  private readonly deadlineMs: number;
  constructor(changed: () => void, deadlineMs = mcpAuthDeadlineMs) { this.changed = changed; this.deadlineMs = deadlineMs; }

  get busy(): boolean { return [...this.attempts.values()].some((attempt) => active(attempt) || attempt.cancellation); }
  list(): { servers: McpAuthCard[] } {
    return { servers: [...this.attempts.values()].filter((attempt) => !attempt.hidden).map(({ card }) => ({ ...card })) };
  }

  async discover(handle: DroidHandle, statusChanged = false): Promise<void> {
    if (statusChanged) for (const attempt of this.attempts.values()) attempt.requiredByNotification = false;
    const generation = this.generation;
    const revision = ++this.revision;
    const { servers } = await handle.listMcpServers();
    if (generation !== this.generation || revision !== this.revision) return;
    let changed = false;
    const listed = new Set(servers.map((server) => server.name));
    for (const [name, attempt] of this.attempts) {
      if (listed.has(name) || attempt.hidden) continue;
      attempt.hidden = true; changed = true;
      if (active(attempt)) {
        this.finish(attempt, "cancelled");
        void this.cancel(name, attempt, handle).catch(() => undefined);
      }
    }
    for (const server of servers) {
      const attempt = this.attempts.get(server.name);
      const authenticated = server.hasAuthTokens && server.status === "connected";
      const needsAuth = server.requiresAuth && (!server.hasAuthTokens || server.status === "failed") && server.status !== "disabled" && !server.blockedByPolicy;
      if (attempt) {
        const hidden = attempt.card.status === "required" && !attempt.requiredByNotification && !needsAuth && !authenticated;
        if (Boolean(attempt.hidden) !== hidden) { attempt.hidden = hidden; changed = true; }
      }
      if (attempt && (active(attempt) || attempt.cancellation || attempt.settled === false)) continue;
      if (attempt && authenticated && !attempt.requiredByNotification && attempt.card.status !== "completed") { this.finish(attempt, "completed"); continue; }
      if (needsAuth && (!attempt || attempt.card.status === "completed")) {
        this.attempts.set(server.name, this.required(server.name)); changed = true;
      }
    }
    if (changed) this.changed();
  }

  async run(action: McpAuthAction, handle: DroidHandle): Promise<{ servers: McpAuthCard[] }> {
    if (action.action === "list") { await this.discover(handle); return this.list(); }
    const server = action.server_name;
    if (!server || server.length > 1024 || /[\u0000-\u001f]/.test(server)) throw new SettingRefused("Choose an MCP server.");
    if (action.action === "start") {
      const generation = this.generation;
      const { servers } = await handle.listMcpServers();
      if (generation !== this.generation) throw new Error("The Droid process ended.");
      const listed = servers.find((item) => item.name === server);
      if (!listed || listed.blockedByPolicy || listed.status === "disabled") throw new SettingRefused("This MCP server is not available for sign-in.");
      const previous = this.attempts.get(server);
      if (previous && active(previous)) return this.list();
      // Notifications carry only a server name, not an attempt id. Drain the old
      // authenticate RPC before accepting the next attempt's auth-required URL.
      if (previous && (previous.settled === false || previous.cancellation)) throw new McpAuthSettling();
      if (previous?.stopFailed) throw new SettingRefused("Droid could not stop the previous sign-in. Restart its host process before trying again.");
      const attempt: Attempt = { card: { auth_id: randomUUID(), server_name: server, status: "starting" }, settled: false };
      this.revision++;
      this.attempts.set(server, attempt);
      attempt.timer = setTimeout(() => {
        if (!this.current(server, attempt) || !active(attempt)) return;
        this.finish(attempt, "cancelled");
        void this.cancel(server, attempt, handle).catch(() => undefined);
      }, this.deadlineMs);
      attempt.timer.unref();
      this.changed();
      // Authentication waits for the browser. Do not hold the device RPC open meanwhile.
      void handle.authenticateMcpServer({ serverName: server }).then(async ({ success }) => {
        if (!this.current(server, attempt) || !active(attempt)) return;
        this.finish(attempt, success ? "completed" : "failed");
        if (!success) await this.cancel(server, attempt, handle).catch(() => undefined);
      }).catch(async () => {
        if (!this.current(server, attempt) || !active(attempt)) return;
        this.finish(attempt, "failed");
        await this.cancel(server, attempt, handle).catch(() => undefined);
      }).finally(() => { attempt.settled = true; });
      return this.list();
    }
    const attempt = this.attempts.get(server);
    if (!attempt || attempt.card.auth_id !== action.auth_id || !active(attempt)) throw new SettingRefused("This sign-in attempt has ended. Start again.");
    if (action.action === "cancel") {
      this.finish(attempt, "cancelled");
      await this.cancel(server, attempt, handle);
      return this.list();
    }
    if (action.action !== "submit") throw new SettingRefused("Choose a valid MCP sign-in action.");
    if (attempt.card.status !== "waiting" || !attempt.state) throw new SettingRefused("Wait for Droid to provide a sign-in link.");
    if (attempt.submitting) throw new SettingRefused("A sign-in code is already being submitted.");
    const code = authCode(action.code, authRedirectState(attempt.card.url!));
    attempt.submitting = true;
    try {
      const { success } = await handle.submitMcpAuthCode({ serverName: server, code, state: attempt.state });
      if (!success) throw new Error("Droid did not accept the MCP sign-in code.");
    } catch (error) {
      if (this.current(server, attempt) && active(attempt)) {
        this.finish(attempt, "failed");
        await this.cancel(server, attempt, handle).catch(() => undefined);
      }
      throw error;
    } finally { attempt.submitting = false; }
    return this.list();
  }

  notification(event: Record<string, unknown>, handle: DroidHandle): void {
    if (event.type === "mcp_status_changed") {
      // Discover safely from typed metadata, never copy raw auth URLs or messages.
      void this.discover(handle, true).catch(() => undefined);
      return;
    }
    if (typeof event.serverName !== "string") return;
    const server = event.serverName;
    let attempt = this.attempts.get(server);
    if (event.type === "mcp_auth_required") {
      this.revision++;
      if (!attempt || (attempt.card.status === "completed" && attempt.settled !== false && !attempt.cancellation)) {
        attempt = this.required(server);
        this.attempts.set(server, attempt);
      }
      if (attempt.card.status === "required") {
        attempt.requiredByNotification = true;
        attempt.hidden = false;
        this.changed();
      }
      if (!active(attempt)) return; // Never expose a URL before the person starts sign-in.
      const url = safeAuthURL(event.authUrl);
      if (!url || typeof event.state !== "string" || !event.state) {
        this.finish(attempt, "failed");
        void this.cancel(server, attempt, handle).catch(() => undefined);
        return;
      }
      attempt.state = event.state;
      attempt.card = { ...attempt.card, status: "waiting", url };
      this.changed();
    }
    // Completion notifications have no attempt id/state. The correlated
    // authenticate RPC settles on success/failure, including localhost callbacks;
    // use that result so an old completion can never finish a newer attempt.
  }

  close(): void {
    this.generation++;
    this.revision++;
    for (const attempt of this.attempts.values()) {
      if (active(attempt)) this.finish(attempt, "cancelled");
      attempt.settled = true; attempt.stopFailed = false; attempt.cancellation = undefined;
    }
  }

  private required(server: string): Attempt { return { card: { auth_id: randomUUID(), server_name: server, status: "required" } }; }
  private cancel(server: string, attempt: Attempt, handle: DroidHandle): Promise<void> {
    if (attempt.cancellation) return attempt.cancellation;
    const generation = this.generation;
    attempt.cancellation = handle.cancelMcpAuth(server).then(({ success }) => {
      if (!success) throw new Error("Droid could not cancel MCP sign-in.");
    }).catch((error) => {
      if (generation === this.generation) attempt.stopFailed = true;
      throw error;
    }).finally(() => { attempt.cancellation = undefined; });
    return attempt.cancellation;
  }
  private current(server: string, attempt: Attempt): boolean { return this.attempts.get(server) === attempt; }
  private finish(attempt: Attempt, status: McpAuthCard["status"]): void {
    this.revision++;
    clearTimeout(attempt.timer);
    attempt.state = undefined;
    attempt.card = { auth_id: attempt.card.auth_id, server_name: attempt.card.server_name, status };
    this.changed();
  }
}

function active(attempt: Attempt): boolean { return attempt.card.status === "starting" || attempt.card.status === "waiting"; }

/** An authorization link is untrusted. Never launch schemes which can execute code or pass URL credentials. */
export function safeAuthURL(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 16_384 || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname) return undefined;
    return url.href;
  } catch { return undefined; }
}

/** The provider echoes this public URL state; Droid's separate state is submitted only to its RPC. */
export function authRedirectState(url: string): string | undefined {
  const states = new URL(url).searchParams.getAll("state");
  return states.length === 1 ? states[0] : undefined;
}

/** A copied redirect is parsed locally; it is never fetched. */
export function authCode(value: unknown, expectedState?: string): string {
  if (typeof value !== "string" || value.length > 16_384) throw new SettingRefused("Paste a sign-in code or redirect URL.");
  let code = value.trim();
  if (/^[a-z][a-z0-9+.-]*:(?:\/\/|.*[?&](?:code|state)=)/i.test(code)) {
    try {
      const url = new URL(code);
      const codes = url.searchParams.getAll("code"), states = url.searchParams.getAll("state");
      if (codes.length !== 1 || states.length > 1 || (states.length && states[0] !== expectedState)) throw new Error();
      code = codes[0];
    } catch { throw new SettingRefused("That redirect URL does not contain a valid sign-in code for this attempt."); }
  }
  if (!code || code.length > 4096 || /\s|[\u0000-\u001f\u007f]/.test(code)) throw new SettingRefused("Paste a valid sign-in code.");
  return code;
}
