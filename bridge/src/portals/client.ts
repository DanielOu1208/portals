import { createConnection } from "node:net";
import WebSocket from "ws";
import { checkSocketFolder } from "../config.ts";
import { callOnce, GatewayError } from "../gateway/call.ts";

// The `portals` command's way to the bridge: one call over its local socket.

export { GatewayError as BridgeError };

export async function callBridge(socketPath: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  try {
    checkSocketFolder(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`The Portals bridge is not running: nothing answers at ${socketPath}.`);
    throw error;
  }
  // The path is given as a connection, not in the address: an address would have the
  // spaces of "Application Support" encoded.
  const open = () => new WebSocket("ws://portals/api/ws", { createConnection: () => createConnection(socketPath), perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  try {
    return await callOnce(open, method, params, timeoutMs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") throw new Error(`The Portals bridge is not running: nothing answers at ${socketPath}.`);
    throw error;
  }
}
