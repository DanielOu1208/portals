import { base64url, fromBase64url, fromUTF8, utf8, type SubtleKey } from "./encoding.ts";

// Relay tokens (docs/pairing-and-relay.md): what the relay gives the app for its
// device, and what a bridge shows when it sends to that device. The relay keeps no list
// of devices. A token carries the device it names and the relay's signature over it, so
// only tokens the relay issued are taken, and nothing has to be stored:
//
//   v1.<base64url of {"t": device token, "e": environment, "b": bundle ID, "i": issued at}>.<base64url of HMAC-SHA256>
//
// The signature covers everything before the last dot. The app and the bridge treat the
// token as opaque, so the format can change with its version.

export type Environment = "production" | "sandbox";

export interface Device {
  /** The address Apple gave the app's installation, as hex. */
  token: string;
  environment: Environment;
  /** The app, which is the APNs topic. */
  bundleID: string;
}

const version = "v1";

/** What a device token is made of, as the bridge's routes take it. */
export const deviceTokenPattern = /^[0-9a-fA-F]{32,200}$/;
export const bundlePattern = /^[A-Za-z0-9.-]{1,200}$/;

const keys = new Map<string, Promise<SubtleKey>>();

function keyFor(secret: string): Promise<SubtleKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, key);
  }
  return key;
}

/** A token for `device`, signed with `secret`. `issuedAt` is in Unix seconds. */
export async function issue(device: Device, secret: string, issuedAt: number): Promise<string> {
  const claims = base64url(utf8(JSON.stringify({ t: device.token.toLowerCase(), e: device.environment, b: device.bundleID, i: Math.floor(issuedAt) })));
  const signed = `${version}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await keyFor(secret), utf8(signed)));
  return `${signed}.${base64url(signature)}`;
}

/**
 * The device `token` names, when one of `secrets` signed it; null for anything else.
 * More than one secret lets the signing secret change without turning away the tokens
 * apps already hold.
 */
export async function verify(token: string, secrets: string[]): Promise<Device | null> {
  if (token.length > 1000) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== version) return null;
  const signature = fromBase64url(parts[2]);
  if (!signature) return null;
  const signed = utf8(`${parts[0]}.${parts[1]}`);
  let valid = false;
  for (const secret of secrets) {
    if (await crypto.subtle.verify("HMAC", await keyFor(secret), signature, signed)) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;
  const bytes = fromBase64url(parts[1]);
  const text = bytes && fromUTF8(bytes);
  if (!text) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { t, e, b } = claims as Record<string, unknown>;
  if (typeof t !== "string" || !deviceTokenPattern.test(t)) return null;
  if (e !== "production" && e !== "sandbox") return null;
  if (typeof b !== "string" || !bundlePattern.test(b)) return null;
  return { token: t, environment: e, bundleID: b };
}

/** A canonical name for a verified token: for rate limits, never for logs. */
export function tokenKey(token: string): string {
  const signature = fromBase64url(token.slice(token.lastIndexOf(".") + 1));
  return signature ? base64url(signature) : "";
}
