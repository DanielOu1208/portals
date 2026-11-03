import CryptoKit
import Foundation
import Synchronization

/// The way to one Mac of the device's net through the relay's tunnel, when its address
/// does not answer (docs/net-plan.md, "The relay as backup, per host"): the relay, the
/// Mac's relay id and static key from its entry in the net's list, and the device's token,
/// which goes sealed in the first frame rather than in a header the relay could read.
public struct RelayRoute: Sendable, Hashable {
    /// The relay's address: `https://…`, or `http://…` for one run locally.
    public var relay: URL
    public var relayID: String
    /// The Mac's static X25519 public key, raw (`S_m`).
    public var macKey: Data
    public var token: String

    /// nil when the entry's key is not 32 bytes of base64url, the relay id is not one, or
    /// the relay's address is not http or https.
    public init?(relay: URL, relayID: String, macKey: String, token: String) {
        guard let key = Data(base64URL: macKey), key.count == TunnelSeal.keyBytes,
              relayID.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil, !token.isEmpty,
              let scheme = relay.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        self.relay = relay
        self.relayID = relayID
        self.macKey = key
        self.token = token
    }

    /// `/v1/tunnel/<relay id>/device` on the relay, as a WebSocket: `http` becomes `ws`,
    /// `https` becomes `wss`.
    public var deviceURL: URL {
        var components = URLComponents(url: relay, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme?.lowercased() == "http" ? "ws" : "wss"
        let base = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = base + "/v1/tunnel/\(relayID)/device"
        components.query = nil
        return components.url!
    }
}

/// The device's leg of the relay's tunnel to a Mac, as a `WebSocketTransport`: what the
/// JSON-RPC peer sends and receives is what it would over the Mac's own WebSocket, sealed
/// end to end on the way (`TunnelSeal`). The relay sees only binary frames it cannot read.
///
/// The handshake begins as the socket opens: the device's ephemeral key, the Mac's, the
/// keys, then the token sealed. Sending and receiving wait for it. The bridge then sends
/// `gateway.ready` as on a direct connection; when it does not take the token, or takes the
/// device out of the net while the tunnel is open, it sends one sealed refusal
/// (`{"refused":"token"}` or `{"refused":"removed"}`) and closes with 4401.
///
/// Only that sealed frame, which only the Mac can make, is a refusal: it is thrown as the
/// 4401 the Mac closes with at its address (`WebSocketClosed`). However the relay's socket
/// closes without one, whatever its code, it is `RelayClosed`, the Mac not reached: the
/// relay, or anything on the way, can close a socket with 4401 too.
public final class RelayTunnelTransport: WebSocketTransport {
    /// Each direction's sealing, once the handshake made the keys.
    private final class Seals: Sendable {
        struct Both {
            var sealer: TunnelSeal.Sealer?
            var opener: TunnelSeal.Opener?
        }

        let both = Mutex(Both())
    }

    private let socket: any TunnelSocket
    private let seals = Seals()
    private let handshake: Task<Void, any Error>

    public convenience init(
        route: RelayRoute,
        session: URLSession = .shared,
        maximumMessageSize: Int = URLSessionWebSocketTransport.defaultMaximumMessageSize
    ) {
        var request = URLRequest(url: route.deviceURL)
        request.timeoutInterval = 30
        let task = session.webSocketTask(with: request)
        // A frame is its message and the tag.
        task.maximumMessageSize = maximumMessageSize + TunnelSeal.tagBytes
        task.resume()
        self.init(route: route, socket: URLSessionTunnelSocket(task: task))
    }

    /// Over `socket`, open or opening: the handshake begins at once.
    init(route: RelayRoute, socket: any TunnelSocket) {
        self.socket = socket
        let seals = seals
        handshake = Task {
            do {
                try await Self.shakeHands(on: socket, route: route, into: seals)
            } catch {
                socket.close()
                throw error
            }
        }
    }

    deinit {
        handshake.cancel()
    }

    /// Steps 1, 2, 3 and 5: the device's ephemeral key out, the Mac's in, both directions'
    /// keys, and the token as the first sealed frame.
    private static func shakeHands(on socket: any TunnelSocket, route: RelayRoute, into seals: Seals) async throws {
        let mine = Curve25519.KeyAgreement.PrivateKey()
        try await relayed { try await socket.send(mine.publicKey.rawRepresentation) }
        guard let theirs = try await relayed({ try await socket.receive() }) else { throw TunnelBroken.handshake }
        let keys = try TunnelSeal.keys(device: mine, mac: theirs, macStatic: route.macKey)
        var sealer = TunnelSeal.Sealer(key: keys.deviceToMac)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        let token = try sealer.seal(try encoder.encode(["token": route.token]))
        seals.both.withLock { $0 = Seals.Both(sealer: sealer, opener: TunnelSeal.Opener(key: keys.macToDevice)) }
        try await relayed { try await socket.send(token) }
    }

    /// `body` on the relay's socket: its close, whatever the code, is the relay's
    /// (`RelayClosed`), never the Mac's refusal.
    private static func relayed<Value>(_ body: () async throws -> Value) async throws -> Value {
        do {
            return try await body()
        } catch let closed as WebSocketClosed {
            throw RelayClosed(closed)
        }
    }

    /// The Mac's sealed refusal, when `plain` is one: `{"refused": …}`, maybe with the
    /// sentence it closes with as `message`. A JSON-RPC message has no `refused` at its top,
    /// and a refusal is short, so a large frame is not read for one.
    static func refusal(in plain: Data) -> WebSocketClosed? {
        guard plain.count <= 4096, plain.range(of: Data(#""refused""#.utf8)) != nil,
              let object = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              let refused = object["refused"] as? String else { return nil }
        let message = (object["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let said = refused == "removed" ? "This device was removed from the net." : "The token was not accepted."
        return WebSocketClosed(code: 4401, reason: message ?? said)
    }

    /// The most JSON a frame carries through the relay; the bridge answers a larger call
    /// with an error, and the relay closes the tunnel for one past its own limit.
    public static let mostFrameBytes = 16 * 1024 * 1024

    // MARK: WebSocketTransport

    public func checkCarries(_ text: String) throws {
        if text.utf8.count > Self.mostFrameBytes { throw TooLargeForRelay() }
    }

    public func send(_ text: String) async throws {
        try await handshake.value
        // One writer at a time (the peer's): frames are sealed in the order they leave.
        let frame = try seals.both.withLock { try $0.sealer!.seal(Data(text.utf8)) }
        try await Self.relayed { try await socket.send(frame) }
    }

    public func receive() async throws -> String {
        try await handshake.value
        let message = try await Self.relayed { try await socket.receive() }
        do {
            // The bridge sends binary frames only.
            guard let frame = message else { throw TunnelBroken.frame }
            let plain = try seals.both.withLock { try $0.opener!.open(frame) }
            if let refusal = Self.refusal(in: plain) { throw refusal }
            return String(decoding: plain, as: UTF8.self)
        } catch {
            close()
            throw error
        }
    }

    public func close() {
        handshake.cancel()
        socket.close()
    }
}

/// The relay's socket under a tunnel: binary frames each way.
protocol TunnelSocket: Sendable {
    /// Throws `WebSocketClosed` when the socket closed.
    func send(_ frame: Data) async throws
    /// The next frame: its bytes, nil for a text frame. Throws `WebSocketClosed`, with the
    /// close code it was given, when the socket closes.
    func receive() async throws -> Data?
    func close()
}

/// `URLSessionWebSocketTask` as a `TunnelSocket`.
struct URLSessionTunnelSocket: TunnelSocket {
    let task: URLSessionWebSocketTask

    func send(_ frame: Data) async throws {
        do {
            try await task.send(.data(frame))
        } catch {
            throw task.closed(error)
        }
    }

    func receive() async throws -> Data? {
        let message: URLSessionWebSocketTask.Message
        do {
            message = try await task.receive()
        } catch {
            throw task.closed(error)
        }
        if case let .data(frame) = message { return frame }
        return nil
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

/// The relay's socket closed, or did not open, with no refusal sealed by the Mac before it.
/// Whatever its close code, a 4401 or 4403 too, the relay or anything on the way could
/// have sent it: the Mac was not reached, and the backend tries again. Never a refusal of
/// the token, which only a sealed frame is (`RelayTunnelTransport`).
public struct RelayClosed: Error, Sendable, Hashable, CustomStringConvertible {
    public var code: Int?
    public var reason: String?
    public var underlying: String?

    public init(code: Int? = nil, reason: String? = nil, underlying: String? = nil) {
        self.code = code
        self.reason = reason
        self.underlying = underlying
    }

    init(_ closed: WebSocketClosed) {
        self.init(code: closed.code, reason: closed.reason, underlying: closed.underlying)
    }

    public var description: String {
        "Through the relay: " + WebSocketClosed(code: code, reason: reason, underlying: underlying).description
    }
}

extension RelayClosed: LocalizedError {
    public var errorDescription: String? {
        if let reason, !reason.isEmpty, code != 4401, code != 4403 { return reason }
        return "The host could not be reached through the relay."
    }
}

/// A call too large for the relay's tunnel, such as a large attachment: it waits for the
/// Mac's address.
public struct TooLargeForRelay: Error, Hashable, Sendable, LocalizedError {
    public init() {}

    public var errorDescription: String? {
        "This is over 16 MiB, too large to send through the relay. Try again when this device reaches the host directly."
    }
}

extension Data {
    /// Bytes from base64url, with or without its padding; nil when it is not base64url.
    init?(base64URL text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        self.init(base64Encoded: base64)
    }
}
