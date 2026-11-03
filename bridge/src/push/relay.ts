import { wellFormedJSON } from "../json.ts";
import { log } from "../log.ts";
import type { Sender, SendResult } from "./apns.ts";
import type { DeviceEntry } from "./store.ts";

// Sends notifications through the Portals relay (relay/, docs/pairing-and-relay.md), for
// a bridge with no APNs key of its own: the relay holds the key of the developer account
// that owns the app. Each device is named by the relay token the app got for it and
// registered with; a device without one cannot be sent to this way.
//
// Neither a relay token nor a device token is ever logged.

const collapsePattern = /^[A-Za-z0-9_.:-]+$/;

export interface RelayOptions {
  /** The relay's address (`push.relay`). */
  url: string;
  /** Unix seconds. */
  now?: () => number;
  /** How long one notification may take to be answered. */
  timeoutMs?: number;
}

export class Relay implements Sender {
  private readonly endpoint: URL;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  /** Devices already logged as having no relay token, so each is logged once. */
  private readonly untokened = new Set<string>();

  constructor(options: RelayOptions) {
    this.endpoint = new URL("/v1/notify", options.url);
    this.now = options.now ?? (() => Date.now() / 1000);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async send(token: string, device: DeviceEntry, payload: object, collapseID = ""): Promise<SendResult> {
    if (!device.relay_token) {
      if (!this.untokened.has(token)) {
        this.untokened.add(token);
        log.info("a device has no relay token, so it gets no notifications until the app registers again with one");
      }
      return "failed";
    }
    const body: Record<string, unknown> = { payload, priority: 10, expiration: Math.floor(this.now()) + 3600 };
    if (collapseID && collapsePattern.test(collapseID)) body.collapse_id = collapseID.slice(0, 64);

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${device.relay_token}` },
        body: wellFormedJSON(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      log.warn("could not reach the notification relay", { error: (error as Error).message });
      return "failed";
    }
    // Read to the end, so the connection can be used again.
    const answer = await response.text().catch(() => "");
    if (response.status === 200) return "sent";
    if (response.status === 410) return "gone";
    if (response.status === 401) {
      log.warn("the notification relay does not take a device's relay token; the app gets a new one when it next opens");
    } else {
      log.warn(`the notification relay answered ${response.status}`, { reason: reasonOf(answer) });
    }
    return "failed";
  }

  close(): void {}
}

function reasonOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown; detail?: unknown };
    const reason = parsed.reason ?? parsed.detail;
    return typeof reason === "string" ? reason.slice(0, 200) : "";
  } catch {
    return "";
  }
}
