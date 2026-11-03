import CryptoKit
import Foundation
import Testing
@testable import HermesBackend

/// The tunnel's handshake and sealing in CryptoKit, against the bridge's test vectors
/// (`Fixtures/tunnel-vectors.json`, a copy of bridge/test/fixtures/tunnel-vectors.json):
/// what the device derives and seals must be byte for byte what the bridge does.
@Suite struct TunnelSealTests {
    private let vectors: JSONValue

    init() throws {
        vectors = try Fixtures.json("tunnel-vectors.json")
    }

    private func bytes(_ value: JSONValue?) throws -> Data {
        let hex = try #require(value?.stringValue)
        return try #require(Data(hex: hex))
    }

    private func privateKey(_ name: String) throws -> Curve25519.KeyAgreement.PrivateKey {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: try bytes(vectors[name]?["private"]))
    }

    @Test func theCopyIsTheBridges() throws {
        // From the package's tests up to the repository, then the bridge's file.
        let bridge = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("bridge/test/fixtures/tunnel-vectors.json")
        try #require(FileManager.default.fileExists(atPath: bridge.path), "No bridge/ beside the package")
        #expect(try Data(contentsOf: bridge) == Data(contentsOf: try Fixtures.url("tunnel-vectors.json")))
    }

    @Test func theKeyPairsAreTheVectors() throws {
        for name in ["mac_static", "device_ephemeral", "mac_ephemeral"] {
            #expect(try privateKey(name).publicKey.rawRepresentation == bytes(vectors[name]?["public"]), "\(name)")
        }
        let key = try #require(vectors["mac_static"]?["public_base64url"]?.stringValue)
        let route = try #require(RelayRoute(relay: URL(string: "https://relay.example")!, relayID: "AAAAAAAAAAAAAAAAAAAAAA", macKey: key, token: "t"))
        #expect(try route.macKey == bytes(vectors["mac_static"]?["public"]))
    }

    @Test func bothSecretsTheSaltAndTheKeysAreTheVectors() throws {
        let device = try privateKey("device_ephemeral")
        let mac = try bytes(vectors["mac_ephemeral"]?["public"])
        let macStatic = try bytes(vectors["mac_static"]?["public"])

        let ephemeral = try device.sharedSecretFromKeyAgreement(with: .init(rawRepresentation: mac)).withUnsafeBytes { Data($0) }
        let fixed = try device.sharedSecretFromKeyAgreement(with: .init(rawRepresentation: macStatic)).withUnsafeBytes { Data($0) }
        #expect(try ephemeral == bytes(vectors["shared_ephemeral"]))
        #expect(try fixed == bytes(vectors["shared_static"]))
        #expect(try ephemeral + fixed == bytes(vectors["ikm"]))
        #expect(try TunnelSeal.salt(device: device.publicKey.rawRepresentation, mac: mac, macStatic: macStatic) == bytes(vectors["salt"]))
        #expect(vectors["info"]?.stringValue == "keys")

        let keys = try TunnelSeal.keys(device: device, mac: mac, macStatic: macStatic)
        #expect(try keys.deviceToMac.withUnsafeBytes { Data($0) } == bytes(vectors["k_dm"]))
        #expect(try keys.macToDevice.withUnsafeBytes { Data($0) } == bytes(vectors["k_md"]))
    }

    @Test func eachNonceIsFourZeroBytesThenTheCounter() throws {
        for frame in (vectors["device_to_mac"]?.arrayValue ?? []) + (vectors["mac_to_device"]?.arrayValue ?? []) {
            let counter = try #require(frame["counter"]?.intValue)
            #expect(try Data(TunnelSeal.nonce(UInt64(counter))) == bytes(frame["nonce"]))
        }
        #expect(Data(TunnelSeal.nonce(0x0102_0304_0506_0708)) == Data([0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]))
    }

    /// The device's frames, its token first, sealed as the bridge expects them; and the
    /// bridge's, the last with characters outside ASCII, opened.
    @Test func framesSealAndOpenAsTheVectorsSay() throws {
        let keys = try TunnelSeal.keys(
            device: try privateKey("device_ephemeral"), mac: try bytes(vectors["mac_ephemeral"]?["public"]),
            macStatic: try bytes(vectors["mac_static"]?["public"])
        )
        var sealer = TunnelSeal.Sealer(key: keys.deviceToMac)
        let out = try #require(vectors["device_to_mac"]?.arrayValue)
        #expect(out.count == 3)
        for frame in out {
            let plain = Data(try #require(frame["plaintext"]?.stringValue).utf8)
            #expect(try sealer.seal(plain) == bytes(frame["sealed"]))
        }
        #expect(out.first?["plaintext"]?.stringValue?.hasPrefix(#"{"token":"#) == true)

        var opener = TunnelSeal.Opener(key: keys.macToDevice)
        let back = try #require(vectors["mac_to_device"]?.arrayValue)
        for frame in back {
            let opened = try opener.open(try bytes(frame["sealed"]))
            #expect(String(decoding: opened, as: UTF8.self) == frame["plaintext"]?.stringValue)
        }
        #expect(back.last?["plaintext"]?.stringValue == "é ✓ 𝄞")

        // And the other way round, as the bridge opens the device's frames.
        var bridge = TunnelSeal.Opener(key: keys.deviceToMac)
        for frame in out {
            #expect(try String(decoding: bridge.open(try bytes(frame["sealed"])), as: UTF8.self) == frame["plaintext"]?.stringValue)
        }
    }

    @Test func aFrameOutOfTurnChangedShortOrUnderAnotherKeyDoesNotOpen() throws {
        let keys = try TunnelSeal.keys(
            device: try privateKey("device_ephemeral"), mac: try bytes(vectors["mac_ephemeral"]?["public"]),
            macStatic: try bytes(vectors["mac_static"]?["public"])
        )
        let back = try #require(vectors["mac_to_device"]?.arrayValue).map { try bytes($0["sealed"]) }

        var outOfTurn = TunnelSeal.Opener(key: keys.macToDevice)
        #expect(throws: TunnelBroken.frame) { try outOfTurn.open(back[1]) }

        var changed = TunnelSeal.Opener(key: keys.macToDevice)
        var tampered = back[0]
        tampered[3] ^= 0x01
        #expect(throws: TunnelBroken.frame) { try changed.open(tampered) }

        var replayed = TunnelSeal.Opener(key: keys.macToDevice)
        _ = try replayed.open(back[0])
        #expect(throws: TunnelBroken.frame) { try replayed.open(back[0]) }

        var short = TunnelSeal.Opener(key: keys.macToDevice)
        #expect(throws: TunnelBroken.frame) { try short.open(Data(count: TunnelSeal.tagBytes - 1)) }

        // The device's own direction's key: a relay sending the device's frames back.
        var wrongKey = TunnelSeal.Opener(key: keys.deviceToMac)
        #expect(throws: TunnelBroken.frame) { try wrongKey.open(back[0]) }
    }

    /// A relay pretending to be the Mac has no private half of its static key: the keys the
    /// device makes with the real static key are not the ones its own key pair gives.
    @Test func anotherStaticKeyMakesOtherKeys() throws {
        let device = try privateKey("device_ephemeral")
        let mac = try bytes(vectors["mac_ephemeral"]?["public"])
        let impostor = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        let keys = try TunnelSeal.keys(device: device, mac: mac, macStatic: impostor)
        #expect(try keys.deviceToMac.withUnsafeBytes { Data($0) } != bytes(vectors["k_dm"]))
    }

    @Test func aKeyThatIsNotOneEndsTheHandshake() throws {
        let device = Curve25519.KeyAgreement.PrivateKey()
        let good = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        #expect(throws: TunnelBroken.handshake) { try TunnelSeal.keys(device: device, mac: Data(count: 31), macStatic: good) }
        #expect(throws: TunnelBroken.handshake) { try TunnelSeal.keys(device: device, mac: good, macStatic: Data(count: 33)) }
        // Of low order: the shared secret would be all zeros, known to anyone.
        #expect(throws: TunnelBroken.handshake) { try TunnelSeal.keys(device: device, mac: Data(count: 32), macStatic: good) }
        #expect(throws: TunnelBroken.handshake) { try TunnelSeal.keys(device: device, mac: good, macStatic: Data(count: 32)) }
    }

    // MARK: The route

    @Test func aRouteIsMadeOnlyFromAUsableEntry() throws {
        let key = try #require(vectors["mac_static"]?["public_base64url"]?.stringValue)
        let relay = URL(string: "https://portals-relay.example.workers.dev")!
        let id = "q1w2e3r4t5y6u7i8o9p0aZ"
        #expect(RelayRoute(relay: relay, relayID: id, macKey: key, token: "token") != nil)
        #expect(RelayRoute(relay: relay, relayID: id, macKey: String(key.dropLast(2)), token: "token") == nil)
        #expect(RelayRoute(relay: relay, relayID: "a/b", macKey: key, token: "token") == nil)
        #expect(RelayRoute(relay: relay, relayID: id, macKey: key, token: "") == nil)
        #expect(RelayRoute(relay: URL(string: "ftp://relay.example")!, relayID: id, macKey: key, token: "token") == nil)
    }

    @Test func theDevicesLegIsTheRelaysTunnelRouteAsAWebSocket() throws {
        let key = try #require(vectors["mac_static"]?["public_base64url"]?.stringValue)
        let id = "q1w2e3r4t5y6u7i8o9p0aZ"
        let deployed = try #require(RelayRoute(relay: URL(string: "https://portals-relay.example.workers.dev/")!, relayID: id, macKey: key, token: "t"))
        #expect(deployed.deviceURL.absoluteString == "wss://portals-relay.example.workers.dev/v1/tunnel/\(id)/device")
        let local = try #require(RelayRoute(relay: URL(string: "http://127.0.0.1:8790")!, relayID: id, macKey: key, token: "t"))
        #expect(local.deviceURL.absoluteString == "ws://127.0.0.1:8790/v1/tunnel/\(id)/device")
    }
}

extension Data {
    /// Bytes from lower-case or upper-case hex; nil for anything else.
    init?(hex: String) {
        guard hex.count.isMultiple(of: 2) else { return nil }
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }
}
