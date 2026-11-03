import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { WebSocketServer } from "ws";
import { checkSocketFolder } from "../config.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { log } from "../log.ts";

// The bridge's local way in (docs/fleet-plan.md): a Unix socket, owner only, for the
// `portals` command. A connection here is one more client of the gateway, speaking the
// protocol the app speaks, with no sign-in: whoever can open the socket is the Mac's
// user, who could read the password file as well. `tailscale serve` forwards the TCP
// port only, so nothing reaches this from another machine.

/** The largest frame read, as on the TCP side. */
const maxFrameBytes = 64 * 1024 * 1024;

export function createLocalServer(gateway: Gateway): Server {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });
  const server = createServer((_request, response) => {
    response.writeHead(404, { "Content-Length": 0 }).end();
  });
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", (error) => log.debug("local upgrade socket error", { error: error.message }));
    sockets.handleUpgrade(request, socket, head, (webSocket) => gateway.accept(webSocket, { kind: "local" }));
  });
  return server;
}

/** Listens on `path`, replacing a socket an earlier run left there, and keeps it to the owner. */
export async function listenLocal(server: Server, path: string): Promise<void> {
  checkSocketFolder(path, true);
  rmSync(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The socket is made as `listen` is called: made with the owner's bits only, so
    // there is no moment in which another user of the Mac could open it.
    const mask = process.umask(0o177);
    try {
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    } finally {
      process.umask(mask);
    }
  });
  chmodSync(path, 0o600);
}

/**
 * Writes the `portals` command of this bridge: a launcher for `entry` (the command's
 * script beside the running bridge) under the node that runs the bridge, which talks to
 * the bridge in `home` whatever the caller's environment says.
 */
export function writeLauncher(options: { command: string; home: string; node: string; entry: string }): void {
  const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const script = [
    "#!/bin/sh",
    "# Written by portals-bridge each time it starts: the `portals` command of the bridge",
    "# that runs from this folder (docs/fleet-plan.md).",
    `PORTALS_BRIDGE_HOME=${quoted(options.home)} exec ${quoted(options.node)} ${quoted(options.entry)} "$@"`,
    "",
  ].join("\n");
  mkdirSync(dirname(options.command), { recursive: true });
  writeFileSync(options.command, script, { mode: 0o755 });
  chmodSync(options.command, 0o755);
}
