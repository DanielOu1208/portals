// Base64url and UTF-8 with only what a Worker and Node both have (no Buffer).

/** A WebCrypto key, named the same way under a Worker's types and Node's. */
export type SubtleKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** The text in `bytes`, or null when they are not UTF-8. */
export function fromUTF8(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The bytes `text` encodes, or null when it is not base64url. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The DER bytes inside a PEM file such as an APNs auth key (`AuthKey_<id>.p8`). */
export function pemBody(pem: string): Uint8Array<ArrayBuffer> | null {
  const body = pem.replace(/-----(BEGIN|END)[A-Z ]*-----/g, "").replace(/\s+/g, "");
  return fromBase64url(body.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""));
}
