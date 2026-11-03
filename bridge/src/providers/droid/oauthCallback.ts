import { createServer, type Server } from "node:http";
import { log } from "../../log.ts";
import { mcpAuthDeadlineMs } from "../mcpAuth.ts";

/** A bridge-owned callback, never a LAN listener or a URL handed to the host browser. */
export class DroidOAuthCallback {
  private readonly waiting = new Map<string, { sdkState: string; redirectState: string; until: number }>();
  private server?: Server;
  private opening?: Promise<string>;
  private readonly submit: (server: string, code: string, state: string) => Promise<{ success: boolean }>;
  /** Ends a server's sign-in in Droid (`droid.cancel_mcp_auth`): the provider's redirect said it was refused. */
  private readonly cancel: (server: string) => Promise<unknown>;
  constructor(submit: (server: string, code: string, state: string) => Promise<{ success: boolean }>, cancel: (server: string) => Promise<unknown> = async () => undefined) {
    this.submit = submit;
    this.cancel = cancel;
  }

  uri(): Promise<string> {
    return this.opening ??= new Promise((resolve, reject) => {
      const server = this.server = createServer((request, response) => {
        const missing = () => { response.writeHead(404, { "content-type": "text/plain" }); response.end("Not found."); };
        if (request.method !== "GET" || !request.url || request.url.length > 16_384 || request.url.split("?")[0] !== "/callback") { missing(); return; }
        const url = new URL(request.url, "http://127.0.0.1");
        if (url.pathname !== "/callback" || url.searchParams.getAll("state").length !== 1) { missing(); return; }
        if (url.searchParams.has("error") && !url.searchParams.has("code")) {
          // The person refused, or the provider failed the sign-in (RFC 6749 4.1.2.1): Droid
          // would wait for a code that never comes, so the attempt is ended at once. What
          // the provider said is not shown or kept.
          const refused = [...this.waiting].find(([, item]) => item.redirectState === url.searchParams.get("state") && item.until > Date.now());
          if (!refused) { missing(); return; }
          this.waiting.delete(refused[0]);
          void this.cancel(refused[0]).catch(() => undefined);
          response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", "referrer-policy": "no-referrer" });
          response.end("Sign-in was cancelled. You can close this tab.");
          return;
        }
        if (url.searchParams.getAll("code").length !== 1) { missing(); return; }
        const state = url.searchParams.get("state")!, code = url.searchParams.get("code")!;
        const entry = [...this.waiting].find(([, item]) => item.redirectState === state && item.until > Date.now());
        if (!entry || !code || code.length > 4096 || /\s|[\u0000-\u001f\u007f]/.test(code)) { missing(); return; }
        this.waiting.delete(entry[0]); // Single-use, including while the submission is in flight.
        void this.submit(entry[0], code, entry[1].sdkState).then(({ success }) => {
          if (!success) { missing(); return; }
          response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", "referrer-policy": "no-referrer" });
          response.end("Signed in. You can close this tab.");
        }).catch(missing);
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        // A later error (accepting a connection with no file descriptors left) would
        // otherwise be thrown at the whole bridge: the callback only misses that request.
        server.on("error", (error: NodeJS.ErrnoException) => log.warn("the Droid MCP sign-in callback had an error", { code: error.code }));
        const address = server.address();
        if (!address || typeof address === "string") { reject(new Error("Could not start the MCP callback.")); return; }
        server.unref();
        resolve(`http://127.0.0.1:${address.port}/callback`);
      });
    });
  }

  remember(server: string, sdkState: string, redirectState: string): void {
    this.waiting.set(server, { sdkState, redirectState, until: Date.now() + mcpAuthDeadlineMs });
  }
  forget(server: string): void { this.waiting.delete(server); }
  async close(): Promise<void> {
    this.waiting.clear();
    // One still starting to listen (a load stopped while it waited for this address) is
    // closed once it listens, never left listening for the life of the bridge.
    await this.opening?.catch(() => undefined);
    this.server?.closeAllConnections();
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    this.opening = undefined;
  }
}
