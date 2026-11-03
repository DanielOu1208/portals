import CryptoKit
import Foundation

/// The tunnel's sealing, the device's side (docs/net-plan.md, "End to end, between device
/// and bridge"; docs/pairing-and-relay.md, "The tunnel"). After the two ephemeral keys,
/// each side derives one key per direction from them and from the Mac's static key, and
/// seals every frame with AES-256-GCM under its direction's key:
///
///     ikm  = X25519(e_d, e_m) ‖ X25519(e_d, S_m)
///     salt = SHA-256("portals-tunnel-v1" ‖ e_d ‖ e_m ‖ S_m)
///     k_dm ‖ k_md = HKDF-SHA256(ikm, salt, info "keys", 64 bytes)
///     frame = AES-256-GCM(key, nonce = 4 zero bytes ‖ counter as 8 bytes big-endian) ‖ 16-byte tag
///
/// The bridge's side is bridge/src/relay/seal.ts; bridge/test/fixtures/tunnel-vectors.json
/// has fixed inputs and outputs both are checked against.
public enum TunnelSeal {
    /// An X25519 public key's raw length, and each direction's key's.
    public static let keyBytes = 32
    /// AES-GCM's tag, after each frame's ciphertext.
    public static let tagBytes = 16

    /// The two directions' keys: the device's frames to the Mac, and the Mac's to the device.
    public struct Keys: Sendable {
        public let deviceToMac: SymmetricKey
        public let macToDevice: SymmetricKey
    }

    /// Step 3, from the device's ephemeral private key and the two public keys it meets:
    /// the Mac's ephemeral (`e_m`, from the bridge) and its static key (`S_m`, from its entry
    /// in the net's list). Throws when either is not a usable X25519 key.
    public static func keys(
        device: Curve25519.KeyAgreement.PrivateKey, mac: Data, macStatic: Data
    ) throws -> Keys {
        guard mac.count == keyBytes, macStatic.count == keyBytes else { throw TunnelBroken.handshake }
        let ephemeral: SharedSecret
        let fixed: SharedSecret
        do {
            // CryptoKit refuses a key of low order, whose shared secret anyone would know.
            ephemeral = try device.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: mac))
            fixed = try device.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: macStatic))
        } catch {
            throw TunnelBroken.handshake
        }
        let ikm = ephemeral.withUnsafeBytes { Data($0) } + fixed.withUnsafeBytes { Data($0) }
        return keys(ikm: ikm, salt: salt(device: device.publicKey.rawRepresentation, mac: mac, macStatic: macStatic))
    }

    /// HKDF-SHA256 over the two shared secrets, 64 bytes: `k_dm`, then `k_md`.
    static func keys(ikm: Data, salt: Data) -> Keys {
        let both = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: Data("keys".utf8), outputByteCount: 2 * keyBytes
        ).withUnsafeBytes { Data($0) }
        return Keys(deviceToMac: SymmetricKey(data: both.prefix(keyBytes)), macToDevice: SymmetricKey(data: both.suffix(keyBytes)))
    }

    /// SHA-256 of the text `portals-tunnel-v1`, then the three public keys, raw.
    static func salt(device: Data, mac: Data, macStatic: Data) -> Data {
        var hash = SHA256()
        hash.update(data: Data("portals-tunnel-v1".utf8))
        hash.update(data: device)
        hash.update(data: mac)
        hash.update(data: macStatic)
        return Data(hash.finalize())
    }

    /// The nonce of the frame numbered `counter`: 4 zero bytes, then the counter as 8 bytes
    /// big-endian.
    static func nonce(_ counter: UInt64) -> AES.GCM.Nonce {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: counter.bigEndian) { bytes.append(contentsOf: $0) }
        // Twelve bytes always make a nonce.
        return try! AES.GCM.Nonce(data: bytes)
    }

    /// Seals one direction's frames, in order.
    public struct Sealer: Sendable {
        private let key: SymmetricKey
        private var counter: UInt64 = 0

        public init(key: SymmetricKey) {
            self.key = key
        }

        public mutating func seal(_ plain: Data) throws -> Data {
            guard counter < .max else { throw TunnelBroken.spent }
            let box = try AES.GCM.seal(plain, using: key, nonce: TunnelSeal.nonce(counter))
            counter += 1
            return box.ciphertext + box.tag
        }
    }

    /// Opens one direction's frames, in order. Throws `TunnelBroken.frame` for a frame that
    /// does not open: out of turn, changed, or sealed under another key.
    public struct Opener: Sendable {
        private let key: SymmetricKey
        private var counter: UInt64 = 0

        public init(key: SymmetricKey) {
            self.key = key
        }

        public mutating func open(_ frame: Data) throws -> Data {
            guard frame.count >= tagBytes else { throw TunnelBroken.frame }
            guard counter < .max else { throw TunnelBroken.spent }
            let plain: Data
            do {
                let box = try AES.GCM.SealedBox(
                    nonce: TunnelSeal.nonce(counter), ciphertext: frame.dropLast(tagBytes), tag: frame.suffix(tagBytes)
                )
                plain = try AES.GCM.open(box, using: key)
            } catch {
                throw TunnelBroken.frame
            }
            counter += 1
            return plain
        }
    }
}

/// Why a tunnel through the relay could not go on. Each closes it; trying again opens a
/// new one, with new keys.
public enum TunnelBroken: Error, Sendable, Hashable {
    /// The Mac's key, from the bridge or from its entry, is not a usable X25519 key, or what
    /// came first was not a key.
    case handshake
    /// A frame through the tunnel did not open: the relay, or something between, is not
    /// passing what the Mac sent, or this is not the Mac.
    case frame
    /// A direction sealed every frame its counter allows.
    case spent
}

extension TunnelBroken: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .handshake: "The host's key through the relay could not be used."
        case .frame: "A message from the host through the relay did not open."
        case .spent: "The connection through the relay ran out of messages. It opens again by itself."
        }
    }
}
