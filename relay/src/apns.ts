import { base64url, pemBody, utf8, type SubtleKey } from "./encoding.ts";
import type { Device, Environment } from "./tokens.ts";

// Sending one notification to Apple's push service (APNs), as the bridge does
// (bridge/src/push/apns.ts; docs/gateway-protocol.md, section 10): a POST to Apple's
// sandbox or production server, by the device's environment, with a provider token
// signed by the APNs auth key. The request goes through `Transport`: fetch in the Worker
// (Apple takes only HTTP/2, which a Worker's fetch speaks to it), a stand-in in tests.
//
// Neither the key, a provider token nor a device token is ever logged.

export const apnsOrigins: Record<Environment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** Sends one request and gives back Apple's answer; throws when there is none. */
export type Transport = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;

/** A transport over `fetch`, as a Worker has it. */
export function fetchTransport(send: typeof fetch = fetch): Transport {
  return async (url, headers, body) => {
    const response = await send(url, { method: "POST", headers, body });
    return { status: response.status, body: await response.text() };
  };
}

export interface ApnsKey {
  /** The contents of the APNs auth key file (`AuthKey_<keyId>.p8`). */
  pem: string;
  /** The key's id: the ten characters in its file name. */
  keyId: string;
  /** The developer team the key belongs to. */
  teamId: string;
}

/**
 * How long one provider token is used, in seconds. Apple accepts a token for an hour
 * and objects to a new one more often than every 20 minutes. Each token's time is the
 * start of its half hour, so every copy of the relay running at once signs the same
 * claims and none of them renews more often than that.
 */
export const tokenWindow = 30 * 60;

/** APNs provider tokens: ES256 JWTs naming the key and the team, signed with the key. */
export class ProviderTokens {
  private readonly key: ApnsKey;
  private signingKey: Promise<SubtleKey> | null = null;
  private token: { window: number; value: string } | null = null;

  constructor(key: ApnsKey) {
    this.key = key;
  }

  /** The token for the half hour `now` (Unix seconds) falls in. Throws when the key is not an APNs auth key. */
  async current(now: number): Promise<string> {
    const window = Math.floor(now / tokenWindow) * tokenWindow;
    if (this.token?.window === window) return this.token.value;
    const header = base64url(utf8(JSON.stringify({ alg: "ES256", kid: this.key.keyId })));
    const claims = base64url(utf8(JSON.stringify({ iss: this.key.teamId, iat: window })));
    // ECDSA in WebCrypto signs as r and s side by side, which is what a JWT holds.
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await this.signer(), utf8(`${header}.${claims}`));
    const value = `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
    this.token = { window, value };
    return value;
  }

  /** Forgets the token and the key, for when Apple turns the token down. */
  reset(): void {
    this.token = null;
    this.signingKey = null;
  }

  private signer(): Promise<SubtleKey> {
    if (!this.signingKey) {
      const der = pemBody(this.key.pem);
      this.signingKey = der
        ? crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
        : Promise.reject(new Error("the APNs key is not a PEM file"));
      // A key that fails to load is tried again next time, not remembered.
      this.signingKey.catch(() => {
        this.signingKey = null;
      });
    }
    return this.signingKey;
  }
}

export interface Notification {
  device: Device;
  /** The payload as JSON, at most 4 KB. */
  payload: string;
  priority: number;
  collapseID?: string;
  /** Unix seconds; 0 asks Apple to try once only. */
  expiration: number;
}

/** What Apple said: `gone` means the device will never take another notification. */
export type AppleAnswer =
  | { outcome: "sent" }
  | { outcome: "gone"; reason: string }
  | { outcome: "busy"; reason: string }
  | { outcome: "failed"; status: number; reason: string };

/** Apple's reasons for a device that will never take another notification. */
const goneReasons = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

export interface Apple {
  send(notification: Notification, now: number): Promise<AppleAnswer>;
}

export class Apns implements Apple {
  private readonly tokens: ProviderTokens;
  private readonly transport: Transport;
  private readonly origins: Record<Environment, string>;

  constructor(options: { key: ApnsKey; transport: Transport; origins?: Record<Environment, string> }) {
    this.tokens = new ProviderTokens(options.key);
    this.transport = options.transport;
    this.origins = options.origins ?? apnsOrigins;
  }

  async send(notification: Notification, now: number): Promise<AppleAnswer> {
    let authorization: string;
    try {
      authorization = `bearer ${await this.tokens.current(now)}`;
    } catch {
      return { outcome: "failed", status: 0, reason: "NoProviderToken" };
    }
    const headers: Record<string, string> = {
      authorization,
      "apns-topic": notification.device.bundleID,
      "apns-push-type": "alert",
      "apns-priority": String(notification.priority),
      "apns-expiration": String(notification.expiration),
      "content-type": "application/json",
    };
    if (notification.collapseID) headers["apns-collapse-id"] = notification.collapseID;
    const url = `${this.origins[notification.device.environment]}/3/device/${notification.device.token}`;

    let answer: { status: number; body: string };
    try {
      answer = await this.transport(url, headers, notification.payload);
    } catch {
      return { outcome: "failed", status: 0, reason: "Unreachable" };
    }
    if (answer.status === 200) return { outcome: "sent" };
    const reason = reasonOf(answer.body);
    if (answer.status === 410 || goneReasons.has(reason)) return { outcome: "gone", reason };
    if (answer.status === 429) return { outcome: "busy", reason };
    // A provider token Apple no longer takes is made again for the next notification.
    if (answer.status === 403) this.tokens.reset();
    return { outcome: "failed", status: answer.status, reason };
  }
}

function reasonOf(body: string): string {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : "";
  } catch {
    return "";
  }
}
