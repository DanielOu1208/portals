import AgentCore
import CryptoKit
import Foundation
import Synchronization
import Testing
@testable import HermesBackend

/// Who may say through the relay that the device's token is refused (docs/pairing-and-relay.md,
/// "The tunnel"): only the Mac, in a frame sealed with the tunnel's keys. The relay can close
/// its socket with any code, 4401 too, as the socket opens or later: that is the Mac not
/// reached, tried again, and never news of a refusal, which is what has the app leave the net,
/// forget its token and remove its hosts (`Net.said`). The tunnel here is the app's own
/// (`RelayTunnelTransport`) over a socket the test plays as the relay, and as the Mac behind it.
@Suite struct RelayRefusalTests {
    private static let route = RelayRoute(
        relay: URL(string: "http://127.0.0.1:8790")!, relayID: "q1w2e3r4t5y6u7i8o9p0aZ",
        macKey: "Q4Zmi5yuCK7mpVPwicnkJXSNrD90polRr7a__xw8Gyw", token: "device-token"
    )!
    private static let ready: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false,
        "bridge": ["protocol": 1, "features": ["activity", "poll_now", "net"], "net": ["id": "3e5a9c1f0b7d2468", "revision": 12]],
    ]
    private static let at = NetNews.at(NetRevision(net: "3e5a9c1f0b7d2468", revision: 12))

    /// The address's sockets, the relay's, the clock, what the backend said of the net, and
    /// the backend over them.
    private struct Rig {
        let backend: HermesBackend
        let direct = TransportSequence()
        let relay = TunnelSocketSequence()
        let clock = TestClock()
        let heard: NewsGathered

        init() {
            let direct = direct
            let relay = relay
            backend = HermesBackend(
                host: HostID(rawValue: "mac"),
                authenticator: TokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9411")!) { "device-token" },
                reconnectDelays: [.milliseconds(500), .seconds(1)],
                network: ScriptedNetworkPaths(.wifi), clock: clock, jitter: { 1 },
                relay: { RelayRefusalTests.route },
                makeTransport: { _ in direct.make() },
                makeRelayTransport: { RelayTunnelTransport(route: $0, socket: relay.make()) }
            )
            heard = NewsGathered(backend.netNews)
        }

        /// The first attempt: the address cannot be reached, so the relay is tried at once.
        func connecting() async throws -> (Task<Void, any Error>, ScriptedTunnelSocket) {
            let connecting = Task { try await backend.connect() }
            try #require(await direct.next()).drop()
            return (connecting, try #require(await within { await relay.next() }))
        }

        /// The attempt after the first failed: the wait, then the relay first, where the Mac
        /// answers this time. What the backend said of the net is then the list's revision
        /// alone, nothing of a refusal.
        func triesAgainAndHearsNoRefusal() async throws {
            try await waitsToTryAgain()
            var mac = try await FakeMac.answer(on: try #require(await within { await relay.next() }))
            try mac.send(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": RelayRefusalTests.ready]])
            #expect(await within { heard.news.isEmpty ? nil : true } == true)
            #expect(heard.news == [RelayRefusalTests.at])
        }

        /// The wait before trying again, past any other the attempt began (the address's limit,
        /// the address's next try while on the relay), over.
        func waitsToTryAgain() async throws {
            while true {
                let sleep = try #require(await clock.nextSleep(), "No wait to try again")
                if sleep == .milliseconds(500) { break }
            }
            clock.advance(by: .milliseconds(500))
        }
    }

    // MARK: The relay's close codes

    @Test func aRelayThatClosesWith4401AsTheSocketOpensIsTheMacNotReached() async throws {
        let rig = Rig()
        let (connecting, socket) = try await rig.connecting()
        socket.close(code: 4401, reason: "The token was not accepted.")
        // When neither way answers, the address's failure is what is said.
        await #expect(throws: ScriptedTransport.Closed.self) { try await connecting.value }
        try await rig.triesAgainAndHearsNoRefusal()
        await rig.backend.disconnect()
    }

    @Test func aRelayThatClosesWith4401AfterTheTokenWentIsTheMacNotReached() async throws {
        let rig = Rig()
        let (connecting, socket) = try await rig.connecting()
        let mac = try await FakeMac.answer(on: socket)
        #expect(mac.token == "device-token")
        socket.close(code: 4401, reason: "This device was removed from the net.")
        await #expect(throws: ScriptedTransport.Closed.self) { try await connecting.value }
        try await rig.triesAgainAndHearsNoRefusal()
        await rig.backend.disconnect()
    }

    @Test func aTunnelTheRelayClosesWith4401OnceOpenIsOpenedAgainWithNoRefusalHeard() async throws {
        let rig = Rig()
        let (connecting, socket) = try await rig.connecting()
        var mac = try await FakeMac.answer(on: socket)
        try mac.send(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": Self.ready]])
        try await connecting.value
        socket.close(code: 4401, reason: "This device was removed from the net.")
        // Opened again through the relay, where the Mac answers.
        try await rig.waitsToTryAgain()
        var again = try await FakeMac.answer(on: try #require(await within { await rig.relay.next() }))
        try again.send(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": Self.ready]])
        #expect(await within { rig.heard.news.count == 2 ? true : nil } == true)
        #expect(rig.heard.news == [Self.at, Self.at])
        await rig.backend.disconnect()
    }

    /// A refusal the relay makes up, not sealed by the Mac, does not open: the tunnel broke.
    @Test func aRefusalNotSealedByTheMacIsNoRefusal() async throws {
        let rig = Rig()
        let (connecting, socket) = try await rig.connecting()
        _ = try await FakeMac.answer(on: socket)
        socket.deliver(Data(#"{"refused":"token"}"#.utf8))
        socket.close(code: 4401, reason: "The token was not accepted.")
        await #expect(throws: ScriptedTransport.Closed.self) { try await connecting.value }
        try await rig.triesAgainAndHearsNoRefusal()
        await rig.backend.disconnect()
    }

    // MARK: The Mac's sealed refusal

    @Test func theMacsSealedRefusalOfTheTokenIsHeardAsItsNo() async throws {
        let rig = Rig()
        let (connecting, socket) = try await rig.connecting()
        var mac = try await FakeMac.answer(on: socket)
        try mac.send(["refused": "token"])
        socket.close(code: 4401, reason: "The token was not accepted.")
        // As a 4401 at the address: the Mac's no, said at once.
        do {
            try await connecting.value
            Issue.record("Connected")
        } catch let closed as WebSocketClosed {
            #expect(closed.code == 4401)
            #expect(closed.reason == "The token was not accepted.")
        }
        #expect(await within { rig.heard.news.isEmpty ? nil : true } == true)
        #expect(rig.heard.news == [.refused("The token was not accepted.")])
        await rig.backend.disconnect()
    }

    @Test func theMacsSealedRemovalOnAnOpenTunnelIsHeardInItsWords() async throws {
        let rig = Rig()
        let (connecting, socket) = try await rig.connecting()
        var mac = try await FakeMac.answer(on: socket)
        try mac.send(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": Self.ready]])
        try await connecting.value
        try mac.send(["refused": "removed", "message": "This iPhone was removed from the net."])
        socket.close(code: 4401, reason: "This iPhone was removed from the net.")
        #expect(await within { rig.heard.news.count == 2 ? true : nil } == true)
        #expect(rig.heard.news == [Self.at, .refused("This iPhone was removed from the net.")])
        await rig.backend.disconnect()
    }

    // MARK: The decisions alone

    @Test func onlyASealedRefusalIsOne() {
        let said = { (text: String) in RelayTunnelTransport.refusal(in: Data(text.utf8)).map { "\($0.code ?? 0) \($0.reason ?? "")" } }
        #expect(said(#"{"refused":"token"}"#) == "4401 The token was not accepted.")
        #expect(said(#"{"refused":"removed"}"#) == "4401 This device was removed from the net.")
        #expect(said(#"{"refused":"removed","message":"Gone."}"#) == "4401 Gone.")
        #expect(said(#"{"jsonrpc":"2.0","method":"event","params":{"refused":"token"}}"#) == nil)
        #expect(said(#"{"refused":true}"#) == nil)
        // The relay's own codes are the Mac not reached, a 4401 or 4403 too.
        #expect(RelayFallback.isUnreachable(RelayClosed(code: 4401, reason: "The token was not accepted.")))
        #expect(RelayFallback.isUnreachable(RelayClosed(code: 4403)))
        #expect(RelayClosed(code: 4401, reason: "The token was not accepted.").localizedDescription == "The host could not be reached through the relay.")
        #expect(RelayClosed(code: 4503, reason: "The Mac is not connected to the relay.").localizedDescription == "The Mac is not connected to the relay.")
    }
}

/// The relay's socket under a tunnel, played by the test: frames to the device, what it sent,
/// and the socket closing with a code.
final class ScriptedTunnelSocket: TunnelSocket {
    private let inbound: AsyncStream<Data>
    private let inboundContinuation: AsyncStream<Data>.Continuation
    private let sent: AsyncStream<Data>
    private let sentContinuation: AsyncStream<Data>.Continuation
    private let closedWith = Mutex<WebSocketClosed?>(nil)

    init() {
        (inbound, inboundContinuation) = AsyncStream.makeStream()
        (sent, sentContinuation) = AsyncStream.makeStream()
    }

    func send(_ frame: Data) async throws {
        if let closed = closedWith.withLock({ $0 }) { throw closed }
        sentContinuation.yield(frame)
    }

    func receive() async throws -> Data? {
        for await frame in inbound {
            return frame
        }
        throw closedWith.withLock { $0 } ?? WebSocketClosed(underlying: "Socket is not connected")
    }

    func close() {
        closedWith.withLock { $0 = $0 ?? WebSocketClosed(code: 1000) }
        inboundContinuation.finish()
        sentContinuation.finish()
    }

    // MARK: Test side

    func deliver(_ frame: Data) {
        inboundContinuation.yield(frame)
    }

    /// The relay closed the socket, or passed on the Mac's close, as `URLSessionWebSocketTask`
    /// says it.
    func close(code: Int, reason: String) {
        closedWith.withLock { $0 = WebSocketClosed(code: code, reason: reason) }
        inboundContinuation.finish()
        sentContinuation.finish()
    }

    func nextSent() async -> Data? {
        for await frame in sent {
            return frame
        }
        return nil
    }
}

final class TunnelSocketSequence: Sendable {
    private let made: AsyncStream<ScriptedTunnelSocket>
    private let continuation: AsyncStream<ScriptedTunnelSocket>.Continuation

    init() {
        (made, continuation) = AsyncStream.makeStream()
    }

    func make() -> ScriptedTunnelSocket {
        let socket = ScriptedTunnelSocket()
        continuation.yield(socket)
        return socket
    }

    func next() async -> ScriptedTunnelSocket? {
        for await socket in made {
            return socket
        }
        return nil
    }
}

/// The Mac behind the relay, with the private half of its static key (the test vectors'):
/// its side of the handshake, and its frames sealed.
struct FakeMac {
    let socket: ScriptedTunnelSocket
    let token: String?
    private var sealer: TunnelSeal.Sealer

    /// Steps 1 to 3 and 5 from the Mac's side: the device's key in, the Mac's out, the
    /// keys, and the device's token opened.
    static func answer(on socket: ScriptedTunnelSocket) async throws -> FakeMac {
        let vectors = try Fixtures.json("tunnel-vectors.json")
        let hex = try #require(vectors["mac_static"]?["private"]?.stringValue)
        let staticKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: try #require(Data(hex: hex)))
        let device = try #require(await socket.nextSent())
        let mine = Curve25519.KeyAgreement.PrivateKey()
        let devicePublic = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: device)
        let ikm = try mine.sharedSecretFromKeyAgreement(with: devicePublic).withUnsafeBytes { Data($0) }
            + staticKey.sharedSecretFromKeyAgreement(with: devicePublic).withUnsafeBytes { Data($0) }
        let keys = TunnelSeal.keys(
            ikm: ikm,
            salt: TunnelSeal.salt(device: device, mac: mine.publicKey.rawRepresentation, macStatic: staticKey.publicKey.rawRepresentation)
        )
        socket.deliver(mine.publicKey.rawRepresentation)
        var opener = TunnelSeal.Opener(key: keys.deviceToMac)
        let first = try opener.open(try #require(await socket.nextSent()))
        return FakeMac(socket: socket, token: try JSONValue.parse(String(decoding: first, as: UTF8.self))["token"]?.stringValue,
                       sealer: TunnelSeal.Sealer(key: keys.macToDevice))
    }

    mutating func send(_ message: JSONValue) throws {
        socket.deliver(try sealer.seal(Data(try message.serialized().utf8)))
    }
}

/// What a backend said of the net, gathered from any task.
final class NewsGathered: Sendable {
    private let heard = Mutex<[NetNews]>([])

    init(_ news: AsyncStream<NetNews>) {
        Task {
            for await said in news {
                self.add(said)
            }
        }
    }

    private func add(_ said: NetNews) {
        heard.withLock { $0.append(said) }
    }

    var news: [NetNews] { heard.withLock { $0 } }
}
