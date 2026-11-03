import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, hkdfSync, type KeyObject } from "node:crypto";

// The tunnel's sealing (docs/net-plan.md, "End to end, between device and bridge";
// docs/pairing-and-relay.md, "The tunnel"). After the two ephemeral keys, each side
// derives one key per direction from them and from the Mac's static key, and seals
// every frame with AES-256-GCM under its direction's key:
//
//   ikm  = X25519(e_d, e_m) ‖ X25519(e_d, S_m)
//   salt = SHA-256("portals-tunnel-v1" ‖ e_d ‖ e_m ‖ S_m)
//   k_dm ‖ k_md = HKDF-SHA256(ikm, salt, info "keys", 64 bytes)
//   frame = AES-256-GCM(key, nonce = 4 zero bytes ‖ counter as 8 bytes big-endian, no additional data) ‖ 16-byte tag
//
// The counter starts at 0 in each direction and goes up by one a frame. The relay holds
// no key; one pretending to be the Mac has no S_m, so the device's first sealed frame
// does not open at the bridge it reaches. bridge/test/fixtures/tunnel-vectors.json has
// fixed inputs and outputs for the app's tests to check CryptoKit against.

/** An X25519 public key's raw length, and each direction's key's. */
export const keyBytes = 32;
/** AES-GCM's tag, after each frame's ciphertext. */
export const tagBytes = 16;

/** The two directions' keys: the device's frames to the Mac, and the Mac's to the device. */
export interface TunnelKeys {
  deviceToMac: Buffer;
  macToDevice: Buffer;
}

/** A frame that does not open: the tunnel closes. */
export class SealBroken extends Error {}

/** An X25519 public key from its raw 32 bytes. Throws for any other length. */
export function publicKeyFrom(raw: Uint8Array): KeyObject {
  if (raw.length !== keyBytes) throw new SealBroken(`An X25519 public key is ${keyBytes} bytes, not ${raw.length}.`);
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
}

/** A key's public half, raw: of a public key, or of a private one. */
export function rawPublicKey(key: KeyObject): Buffer {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  return Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
}

/** X25519 between a private key and another's public key. */
export function x25519(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  return diffieHellman({ privateKey, publicKey });
}

/**
 * Step 3: both directions' keys, from the two shared secrets (the ephemerals', then the
 * device's ephemeral with the Mac's static key) and the three public keys, raw.
 */
export function tunnelKeys(shared: { ephemeral: Uint8Array; static: Uint8Array }, publics: { device: Uint8Array; mac: Uint8Array; macStatic: Uint8Array }): TunnelKeys {
  const ikm = Buffer.concat([shared.ephemeral, shared.static]);
  const salt = tunnelSalt(publics);
  const keys = Buffer.from(hkdfSync("sha256", ikm, salt, "keys", 2 * keyBytes));
  return { deviceToMac: keys.subarray(0, keyBytes), macToDevice: keys.subarray(keyBytes) };
}

export function tunnelSalt(publics: { device: Uint8Array; mac: Uint8Array; macStatic: Uint8Array }): Buffer {
  return createHash("sha256").update("portals-tunnel-v1").update(publics.device).update(publics.mac).update(publics.macStatic).digest();
}

/** The nonce of the frame numbered `counter`: 4 zero bytes, then the counter as 8 bytes big-endian. */
export function tunnelNonce(counter: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

const lastCounter = 2n ** 64n - 1n;

/** Seals one direction's frames, in order. */
export class Sealer {
  private readonly key: Buffer;
  private counter = 0n;

  constructor(key: Buffer) {
    this.key = key;
  }

  seal(plain: Uint8Array): Buffer {
    if (this.counter > lastCounter) throw new SealBroken("The tunnel has sealed all the frames it can.");
    const cipher = createCipheriv("aes-256-gcm", this.key, tunnelNonce(this.counter++));
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }
}

/** Opens one direction's frames, in order. Throws `SealBroken` for a frame that does not open. */
export class Opener {
  private readonly key: Buffer;
  private counter = 0n;

  constructor(key: Buffer) {
    this.key = key;
  }

  open(frame: Uint8Array): Buffer {
    if (frame.length < tagBytes) throw new SealBroken("A frame through the tunnel is shorter than its tag.");
    if (this.counter > lastCounter) throw new SealBroken("The tunnel has opened all the frames it can.");
    const decipher = createDecipheriv("aes-256-gcm", this.key, tunnelNonce(this.counter));
    decipher.setAuthTag(frame.subarray(frame.length - tagBytes));
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(frame.subarray(0, frame.length - tagBytes)), decipher.final()]);
    } catch {
      throw new SealBroken("A frame through the tunnel did not open.");
    }
    this.counter += 1n;
    return plain;
  }
}
