import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { connect, constants, type ClientHttp2Session, type OutgoingHttpHeaders } from "node:http2";
import { expandHome, type ApnsConfig } from "../config.ts";
import { wellFormedJSON } from "../json.ts";
import { log } from "../log.ts";
import type { DeviceEntry } from "./store.ts";

// Sends one notification to one device through Apple's push service (APNs), as the
// `aeriportal-push` Hermes plugin does (hermes-plugin/aeriportal-push/core.py, `Apns`;
// docs/gateway-protocol.md, section 10): HTTP/2 to Apple's sandbox or production server,
// by the device's environment, with a provider token signed by the APNs auth key.
//
// Neither the key, the provider token nor a device token is ever logged.

/** What became of a notification: `gone` means the device no longer takes them, so it is forgotten. */
export type SendResult = "sent" | "gone" | "failed";

export interface Sender {
  send(token: string, device: DeviceEntry, payload: object, collapseID?: string): Promise<SendResult>;
  close(): void;
}

/**
 * How long a provider token is reused, in seconds. Apple accepts one for an hour and
 * objects to a new one more often than every 20 minutes.
 */
export const tokenLifetime = 50 * 60;

export const apnsOrigins: Record<DeviceEntry["environment"], string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

// What a device token, a bundle id and a collapse id are made of. The routes accept
// nothing else; these catch a state file edited by hand.
const tokenPattern = /^[0-9a-fA-F]+$/;
const bundlePattern = /^[A-Za-z0-9.-]+$/;
const collapsePattern = /^[A-Za-z0-9_.:-]+$/;

/** Apple's reasons for a device that will never take another notification. */
const goneReasons = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

/** An APNs provider token: an ES256 JWT naming the key and the team, signed with the key. */
export function providerToken(key: KeyObject, keyID: string, teamID: string, issuedAt: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyID })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: teamID, iat: issuedAt })).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

export interface ApnsOptions {
  config: ApnsConfig;
  /** Unix seconds. */
  now?: () => number;
  /** Apple's servers; tests name a server of their own. */
  origins?: Record<DeviceEntry["environment"], string>;
  /** How long one notification may take to be answered. */
  timeoutMs?: number;
}

export class Apns implements Sender {
  private readonly config: ApnsConfig;
  private readonly now: () => number;
  private readonly origins: Record<DeviceEntry["environment"], string>;
  private readonly timeoutMs: number;
  private token: { madeAt: number; value: string } | null = null;
  /** One HTTP/2 connection per server, kept for the next notification as Apple asks. */
  private readonly connections = new Map<string, ClientHttp2Session>();

  constructor(options: ApnsOptions) {
    this.config = options.config;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.origins = options.origins ?? apnsOrigins;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** The provider token, made again once it is `tokenLifetime` old. Throws when the key cannot be read. */
  providerToken(): string {
    const now = this.now();
    if (this.token && now - this.token.madeAt < tokenLifetime) return this.token.value;
    // Read each time a token is made, so a replaced key is picked up without a restart.
    const key = createPrivateKey(readFileSync(expandHome(this.config.keyPath), "utf8"));
    const value = providerToken(key, this.config.keyId, this.config.teamId, Math.floor(now));
    this.token = { madeAt: now, value };
    return value;
  }

  async send(token: string, device: DeviceEntry, payload: object, collapseID = ""): Promise<SendResult> {
    const topic = typeof device.bundle_id === "string" ? device.bundle_id : "";
    if (!tokenPattern.test(token) || !bundlePattern.test(topic)) {
      log.warn("a registered device is not a token and a bundle id; dropped");
      return "gone";
    }
    let authorization: string;
    try {
      authorization = `bearer ${this.providerToken()}`;
    } catch (error) {
      log.warn("could not make an APNs provider token: is apns.keyPath an APNs auth key?", { error: (error as Error).message });
      return "failed";
    }
    const headers: OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(this.now()) + 3600),
      "content-type": "application/json",
    };
    if (collapseID && collapsePattern.test(collapseID)) headers["apns-collapse-id"] = collapseID.slice(0, 64);

    let answer: { status: number; body: string };
    try {
      answer = await this.post(this.origins[device.environment === "production" ? "production" : "sandbox"], headers, wellFormedJSON(payload));
    } catch (error) {
      log.warn("could not send a notification to APNs", { error: (error as Error).message });
      return "failed";
    }
    if (answer.status === 200) return "sent";
    const reason = reasonOf(answer.body);
    if (answer.status === 410 || goneReasons.has(reason)) return "gone";
    // A provider token Apple no longer accepts is made again for the next one.
    if (answer.status === 403) this.token = null;
    log.warn(`APNs answered ${answer.status}${reason ? ` ${reason}` : ""}`);
    return "failed";
  }

  close(): void {
    for (const connection of this.connections.values()) connection.destroy();
    this.connections.clear();
  }

  private post(origin: string, headers: OutgoingHttpHeaders, body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        outcome();
      };
      const stream = this.connection(origin).request(headers);
      let status = 0;
      const chunks: Buffer[] = [];
      stream.setTimeout(this.timeoutMs, () => {
        finish(() => reject(new Error("APNs did not answer in time")));
        stream.close(constants.NGHTTP2_CANCEL);
      });
      stream.on("response", (response) => {
        status = Number(response[":status"]);
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => finish(() => resolve({ status, body: Buffer.concat(chunks).toString("utf8") })));
      stream.on("error", (error) => finish(() => reject(error)));
      stream.on("close", () => finish(() => reject(new Error("the connection to APNs closed before it answered"))));
      stream.end(body);
    });
  }

  private connection(origin: string): ClientHttp2Session {
    const existing = this.connections.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const connection = connect(origin);
    const forget = () => {
      if (this.connections.get(origin) === connection) this.connections.delete(origin);
    };
    connection.on("error", (error) => {
      forget();
      log.warn("the connection to APNs failed", { error: error.message });
    });
    connection.on("goaway", forget);
    connection.on("close", forget);
    // Kept while notifications come; one idle for a while is let go.
    connection.setTimeout(10 * 60 * 1000, () => connection.close());
    this.connections.set(origin, connection);
    return connection;
  }
}

/** Writes each notification to a file, as a line of JSON, instead of sending it (`push.dryRun`). */
export class DryRun implements Sender {
  private readonly path: string;

  constructor(path: string) {
    this.path = expandHome(path);
  }

  async send(token: string, device: DeviceEntry, payload: object, collapseID = ""): Promise<SendResult> {
    // Only the start of the token, as the plugin's dry run writes it: enough to tell devices apart.
    const line = { device: token.slice(0, 8), environment: device.environment, topic: device.bundle_id, collapse_id: collapseID, payload };
    try {
      appendFileSync(this.path, JSON.stringify(line) + "\n", { mode: 0o600 });
      return "sent";
    } catch (error) {
      log.warn("could not write a notification to the push.dryRun file", { error: (error as Error).message });
      return "failed";
    }
  }

  close(): void {}
}

function reasonOf(body: string): string {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : "";
  } catch {
    return "";
  }
}
