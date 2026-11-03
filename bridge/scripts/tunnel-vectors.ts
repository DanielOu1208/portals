import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { publicKeyFrom, rawPublicKey, Sealer, tunnelKeys, tunnelNonce, tunnelSalt, x25519 } from "../src/relay/seal.ts";

// The tunnel's test vectors (test/fixtures/tunnel-vectors.json, described in
// docs/pairing-and-relay.md): fixed keys, what they derive, and a few sealed frames each
// way, for the bridge's tests and the app's to check their sealing against. Every key is
// made from a fixed phrase, so running this again writes the same file.
//
//   node scripts/tunnel-vectors.ts          writes the file
//   node scripts/tunnel-vectors.ts --print  prints it instead

/** An X25519 private key from its raw 32 bytes (PKCS #8 around them). */
export function privateKeyFrom(raw: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), raw]), format: "der", type: "pkcs8" });
}

function fixedKey(phrase: string): { raw: Buffer; key: KeyObject } {
  const raw = createHash("sha256").update(phrase).digest();
  return { raw, key: privateKeyFrom(raw) };
}

/** The token in the device's first frame: a made-up one, 32 bytes in base64url like a real one. */
const token = createHash("sha256").update("portals tunnel vectors: device token").digest("base64url");

/** What each side seals, in order: the device's token first, then JSON-RPC both ways. */
const plaintexts = {
  device_to_mac: [JSON.stringify({ token }), JSON.stringify({ jsonrpc: "2.0", id: "r1", method: "threads.list", params: {} }), ""],
  mac_to_device: [
    JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { heartbeat: true } } }),
    JSON.stringify({ jsonrpc: "2.0", id: "r1", result: { threads: [], machines: [] } }),
    "é ✓ 𝄞",
  ],
};

export function makeVectors(): Record<string, unknown> {
  const macStatic = fixedKey("portals tunnel vectors: Mac static key");
  const deviceEphemeral = fixedKey("portals tunnel vectors: device ephemeral key");
  const macEphemeral = fixedKey("portals tunnel vectors: Mac ephemeral key");
  const publics = { device: rawPublicKey(deviceEphemeral.key), mac: rawPublicKey(macEphemeral.key), macStatic: rawPublicKey(macStatic.key) };
  const shared = { ephemeral: x25519(deviceEphemeral.key, publicKeyFrom(publics.mac)), static: x25519(deviceEphemeral.key, publicKeyFrom(publics.macStatic)) };
  const keys = tunnelKeys(shared, publics);
  const frames = (direction: "device_to_mac" | "mac_to_device") => {
    const sealer = new Sealer(direction === "device_to_mac" ? keys.deviceToMac : keys.macToDevice);
    return plaintexts[direction].map((plaintext, counter) => ({
      counter,
      plaintext,
      nonce: hex(tunnelNonce(BigInt(counter))),
      sealed: hex(sealer.seal(Buffer.from(plaintext, "utf8"))),
    }));
  };
  return {
    about:
      "Test vectors for the Portals tunnel's handshake and sealing (docs/pairing-and-relay.md, The tunnel). Bytes are hex; plaintext is UTF-8. Made by bridge/scripts/tunnel-vectors.ts.",
    mac_static: { private: hex(macStatic.raw), public: hex(publics.macStatic), public_base64url: publics.macStatic.toString("base64url") },
    device_ephemeral: { private: hex(deviceEphemeral.raw), public: hex(publics.device) },
    mac_ephemeral: { private: hex(macEphemeral.raw), public: hex(publics.mac) },
    shared_ephemeral: hex(shared.ephemeral),
    shared_static: hex(shared.static),
    ikm: hex(Buffer.concat([shared.ephemeral, shared.static])),
    salt: hex(tunnelSalt(publics)),
    info: "keys",
    k_dm: hex(keys.deviceToMac),
    k_md: hex(keys.macToDevice),
    device_to_mac: frames("device_to_mac"),
    mac_to_device: frames("mac_to_device"),
  };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = JSON.stringify(makeVectors(), null, 2) + "\n";
  if (process.argv.includes("--print")) process.stdout.write(text);
  else writeFileSync(fileURLToPath(new URL("../test/fixtures/tunnel-vectors.json", import.meta.url)), text);
}
