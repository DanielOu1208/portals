import { createCipheriv, randomBytes } from "node:crypto";
import { wellFormedJSON } from "../json.ts";
import { preview, type Payload } from "./notifier.ts";

// Sealed notifications (docs/pairing-and-relay.md). A device that gave this bridge a key
// gets the words of each notification sealed to it: Apple and the relay see only the
// placeholder below, and the app's notification extension opens the seal and shows the
// real ones. The seal is AES-256-GCM, written as nonce (12 bytes) + ciphertext + tag
// (16 bytes) in base64, which is CryptoKit's `AES.GCM.SealedBox.combined`.

/** What a sealed notification shows until the app has opened it, or if it cannot. */
export const placeholder = { title: "Portals", body: "New activity" } as const;

/** The largest payload Apple takes for a notification, in bytes. */
export const payloadLimit = 4096;

/** The words a seal holds. */
export interface SealedText {
  title: string;
  subtitle?: string;
  body: string;
}

/**
 * `text` sealed to `key` (32 bytes). The nonce is random; tests name one. Half of a
 * surrogate pair goes in as U+FFFD (`wellFormedJSON`): the app's JSONDecoder refuses the
 * whole seal for one, and shows the placeholder.
 */
export function seal(text: SealedText, key: Buffer, nonce: Buffer = randomBytes(12)): string {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(wellFormedJSON(text), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString("base64");
}

/** A device's key from its registration (base64), or null when it is not 32 bytes. */
export function deviceKey(encoded: string): Buffer | null {
  const key = Buffer.from(encoded, "base64");
  return key.length === 32 ? key : null;
}

/**
 * `payload` with its words sealed to `key` (the device's, base64) under
 * `aeriportal.sealed`, and the placeholder in their place. The body, then the title and
 * subtitle, are shortened until the whole payload fits in Apple's 4 KB. A key that is not
 * one gets the placeholder alone: a device that asked for sealed words never gets them in
 * the open.
 */
export function sealed(payload: Payload, encodedKey: string, nonce?: Buffer): Payload {
  const { aeriportal, aps } = payload;
  const open: Payload = { aps: { ...aps, alert: { ...placeholder } }, aeriportal: { ...aeriportal } };
  delete open.aeriportal.sealed;
  const key = deviceKey(encodedKey);
  if (!key) return open;

  const text: SealedText = { title: aps.alert.title, body: aps.alert.body };
  if (aps.alert.subtitle) text.subtitle = aps.alert.subtitle;
  for (;;) {
    const result: Payload = { ...open, aeriportal: { ...open.aeriportal, sealed: seal(text, key, nonce) } };
    const over = Buffer.byteLength(JSON.stringify(result)) - payloadLimit;
    if (over <= 0) return result;
    // Base64 takes four characters for three bytes, and a character is up to four bytes:
    // cutting this many characters is always enough for this round, rarely much more.
    const cut = Math.ceil((over * 3) / 4);
    if (Array.from(text.body).length > 1) {
      text.body = shortened(text.body, cut);
    } else if (text.subtitle) {
      delete text.subtitle;
    } else if (Array.from(text.title).length > 1) {
      text.title = shortened(text.title, cut);
    } else {
      return open;
    }
  }
}

function shortened(text: string, cut: number): string {
  const characters = Array.from(text).length;
  return preview(text, Math.max(1, characters - cut));
}
