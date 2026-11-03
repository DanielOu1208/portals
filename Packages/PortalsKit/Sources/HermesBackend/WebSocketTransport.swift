import Foundation

/// A text-frame WebSocket, small enough to script in tests.
public protocol WebSocketTransport: Sendable {
    func send(_ text: String) async throws
    /// The next text frame. Throws when the socket closes.
    func receive() async throws -> String
    func close()
    /// Throws, with a sentence for the person, when `text` is a frame this socket does not
    /// carry, before it is queued: sending it would close the socket. Most carry anything.
    func checkCarries(_ text: String) throws
}

extension WebSocketTransport {
    public func checkCarries(_ text: String) throws {}
}

/// The socket closed; `code` is the WebSocket close code when the peer sent one.
public struct WebSocketClosed: Error, Sendable, CustomStringConvertible {
    public var code: Int?
    public var reason: String?
    public var underlying: String?

    public init(code: Int? = nil, reason: String? = nil, underlying: String? = nil) {
        self.code = code
        self.reason = reason
        self.underlying = underlying
    }

    /// Hermes closes with 4401 when the token, ticket or session is not accepted.
    public var isUnauthorized: Bool { code == 4401 }
    /// Hermes closes with 4403 when the Host or Origin is rejected.
    public var isForbidden: Bool { code == 4403 }

    public var description: String {
        var parts = ["WebSocket closed"]
        if let code { parts.append("code \(code)") }
        if let reason, !reason.isEmpty { parts.append(reason) }
        if let underlying { parts.append(underlying) }
        return parts.joined(separator: ": ")
    }
}

extension WebSocketClosed: LocalizedError {
    public var errorDescription: String? {
        if isUnauthorized { return "The host did not accept the sign-in." }
        if isForbidden { return "The host refused the connection." }
        return underlying ?? "The connection to the host closed."
    }
}

/// `URLSessionWebSocketTask` as a `WebSocketTransport`.
public final class URLSessionWebSocketTransport: WebSocketTransport {
    /// Hermes accepts frames up to 384 MiB; history and image frames can be large.
    public static let defaultMaximumMessageSize = 64 * 1024 * 1024

    private let task: URLSessionWebSocketTask

    public init(
        request: URLRequest,
        session: URLSession = .shared,
        maximumMessageSize: Int = URLSessionWebSocketTransport.defaultMaximumMessageSize
    ) {
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = maximumMessageSize
        task.resume()
    }

    public func send(_ text: String) async throws {
        do {
            try await task.send(.string(text))
        } catch {
            throw task.closed(error)
        }
    }

    public func receive() async throws -> String {
        while true {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                throw task.closed(error)
            }
            switch message {
            case let .string(text):
                return text
            case let .data(data):
                return String(decoding: data, as: UTF8.self)
            @unknown default:
                continue
            }
        }
    }

    public func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

extension URLSessionWebSocketTask {
    /// The socket closed with `error`: its close code and reason when the peer sent them.
    func closed(_ error: any Error) -> WebSocketClosed {
        let raw = closeCode.rawValue
        return WebSocketClosed(
            code: raw > 0 ? raw : nil,
            reason: closeReason.flatMap { String(data: $0, encoding: .utf8) },
            underlying: error.localizedDescription
        )
    }
}
