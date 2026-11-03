import Foundation

/// An error object from a JSON-RPC response.
public struct JSONRPCError: Error, Sendable, Hashable {
    public var code: Int
    public var message: String
    public var data: JSONValue?

    public init(code: Int, message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }

    /// The method is not implemented by the receiver.
    public static let methodNotFoundCode = -32601
    /// The receiver does not take what the request carried.
    public static let invalidParamsCode = -32602
}

extension JSONRPCError: LocalizedError {
    public var errorDescription: String? { message }
}

/// One `event` notification from the gateway.
///
/// Wire shape: `{"jsonrpc":"2.0","method":"event","params":{"type","session_id","seq","payload"}}`.
public struct GatewayEvent: Sendable, Hashable {
    public var type: String
    /// The runtime session the event belongs to; nil for connection-wide events.
    public var sessionID: String?
    /// Position in the session's replay log.
    public var seq: Int?
    public var payload: JSONValue
    /// Local transport order, not a wire field: which frame on the socket it came in, by
    /// which an answer that came before it (`JSONRPCPeer.ReceivedResponse.frame`) is
    /// known to be older, however the two reach whoever applies them.
    public var receivedAtFrame: Int?

    public init(type: String, sessionID: String? = nil, seq: Int? = nil, payload: JSONValue = .null) {
        self.type = type
        self.sessionID = sessionID
        self.seq = seq
        self.payload = payload
    }
}

extension GatewayEvent {
    /// An event as `session.events.since` returns it: the `params` of an event frame.
    public init?(replayed entry: JSONValue) {
        guard let type = entry["type"]?.stringValue else { return nil }
        self.init(
            type: type,
            sessionID: entry["session_id"]?.stringValue,
            seq: entry["seq"]?.intValue,
            payload: entry["payload"] ?? .null
        )
    }
}

/// No frame contents: this also becomes the connection's readable close reason.
struct LeanDeltaFormatError: Error, LocalizedError {
    var errorDescription: String? { "The host sent a compact reply that could not be read. Reconnecting." }
}

/// A question the gateway asks the client (approval, clarify, …). It is answered with a
/// response frame carrying the same id.
public struct ServerRequest: Sendable, Hashable {
    public var id: String
    public var method: String
    public var params: JSONValue
    /// Local transport order, not a wire field. A full resume's receipt is the
    /// boundary between requests replaced by its snapshot and requests after it.
    public var receivedAtFrame: Int?

    public init(id: String, method: String, params: JSONValue = .null) {
        self.id = id
        self.method = method
        self.params = params
    }
}

/// What one inbound text frame is.
public enum InboundFrame: Sendable, Hashable {
    /// The answer to one of our requests (or to a heartbeat ping).
    case response(id: String, outcome: Result<JSONValue, JSONRPCError>)
    case serverRequest(ServerRequest)
    case event(GatewayEvent)
    /// Valid JSON that is none of the above. Ignored.
    case unrecognized

    /// Classifies a frame the same way Hermes's own client does
    /// (`apps/shared/src/json-rpc-channel.ts`): `method == "event"` is a notification, a
    /// string id with any other method is a server request, and an id with `result` or
    /// `error` is a response.
    public static func parse(_ text: String) throws -> InboundFrame {
        guard case let .object(frame) = try JSONValue.parse(text) else { return .unrecognized }
        let method = frame["method"]?.stringValue

        if method == "event" {
            guard let params = frame["params"], let type = params["type"]?.stringValue else { return try leanDelta(frame) }
            return .event(GatewayEvent(
                type: type,
                sessionID: params["session_id"]?.stringValue,
                seq: params["seq"]?.intValue,
                payload: params["payload"] ?? .null
            ))
        }

        if let method, let id = frame["id"]?.stringValue {
            return .serverRequest(ServerRequest(id: id, method: method, params: frame["params"] ?? .null))
        }

        guard let id = frame["id"].flatMap(responseID) else { return try leanDelta(frame) }
        if let error = frame["error"], !error.isNull {
            return .response(id: id, outcome: .failure(JSONRPCError(
                code: error["code"]?.intValue ?? 0,
                message: error["message"]?.stringValue ?? "Unknown error",
                data: error["data"]
            )))
        }
        if let result = frame["result"] {
            return .response(id: id, outcome: .success(result))
        }
        return try leanDelta(frame)
    }

    /// A malformed compact event must not advance past missing text. The peer closes,
    /// so the backend reconnects and resumes from the last event it could read.
    private static func leanDelta(_ frame: [String: JSONValue]) throws -> InboundFrame {
        guard frame["d"] != nil || frame["t"] != nil else { return .unrecognized }
        let key = frame["d"] == nil ? "t" : "d"
        guard frame.count == 1, let tuple = frame[key]?.arrayValue, tuple.count == 3,
              let session = tuple[0].stringValue, !session.isEmpty,
              let seq = tuple[1].intValue, seq > 0,
              let text = tuple[2].stringValue else { throw LeanDeltaFormatError() }
        return .event(GatewayEvent(
            type: key == "d" ? "message.delta" : "reasoning.delta",
            sessionID: session, seq: seq, payload: ["text": .string(text)]
        ))
    }

    /// Our request ids are strings; a numeric echo is accepted too.
    private static func responseID(_ value: JSONValue) -> String? {
        if let text = value.stringValue { return text }
        if let number = value.intValue { return String(number) }
        return nil
    }
}
