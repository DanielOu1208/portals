import Foundation
import OSLog

public enum JSONRPCPeerError: Error, Sendable, Hashable {
    /// The peer was closed before or while the call was pending.
    case closed
    case timedOut(method: String)
    /// Nothing arrived from the gateway within the heartbeat deadline.
    case heartbeatTimedOut
}

extension JSONRPCPeerError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .closed: "The connection to the host closed."
        case let .timedOut(method): "The host did not answer in time (\(method))."
        case .heartbeatTimedOut: "The host stopped responding."
        }
    }
}

/// One JSON-RPC 2.0 conversation over a WebSocket, in both directions.
///
/// - Our requests are matched to responses by id.
/// - `event` notifications and the questions the gateway asks (approval, clarify, …)
///   come out of `inbound` as one stream, in arrival order: a question and the event
///   that withdraws it must not overtake each other.
/// - Questions are answered with `respond(to:result:)` or `reject(_:code:message:)`.
/// - `startHeartbeat()` sends `gateway.ping` and closes the socket when the gateway goes
///   quiet, which is the only liveness check behind a loopback proxy. `checkAlive(within:)`
///   does it once, at once, with a shorter deadline.
///
/// Frames are written by one task, so they leave in the order they were queued.
public actor JSONRPCPeer {
    private static let log = Logger(subsystem: "Portals", category: "Gateway")
    public struct Options: Sendable {
        public var heartbeatInterval: Duration = .seconds(15)
        public var heartbeatDeadline: Duration = .seconds(45)
        public var requestTimeout: Duration = .seconds(60)

        public init() {}
    }

    /// Everything the gateway sends that is not an answer to one of our requests.
    public enum Inbound: Sendable, Hashable {
        case event(GatewayEvent)
        /// A question to answer by id.
        case request(ServerRequest)
    }

    /// Events and server→client requests, in arrival order. One consumer at a time.
    /// Ends when the peer closes.
    public nonisolated let inbound: AsyncStream<Inbound>

    /// Why the peer closed; nil while open, and after a plain `close()`.
    public private(set) var closeError: (any Error)?
    public private(set) var isClosed = false

    private struct Pending {
        /// Told once: the result, or why there is none.
        let answered: @Sendable (Result<ReceivedResponse, any Error>) -> Void
        let timeout: Task<Void, Never>
    }

    private let transport: any WebSocketTransport
    private let options: Options
    private let inboundContinuation: AsyncStream<Inbound>.Continuation
    private let outbound: AsyncStream<String>
    private let outboundContinuation: AsyncStream<String>.Continuation

    private var pending: [String: Pending] = [:]
    private var requestNumber = 0
    private var heartbeatNumber = 0
    private var lastInbound = ContinuousClock.now
    /// How many frames have arrived: a check of the socket compares it before and after.
    private var framesReceived = 0
    private var ioTasks: [Task<Void, Never>] = []
    private var heartbeatTask: Task<Void, Never>?

    public init(transport: any WebSocketTransport, options: Options = Options()) {
        self.transport = transport
        self.options = options
        (inbound, inboundContinuation) = AsyncStream.makeStream(of: Inbound.self)
        (outbound, outboundContinuation) = AsyncStream.makeStream(of: String.self)
    }

    /// Starts reading and writing. Call once, before the first request.
    public func start() {
        guard ioTasks.isEmpty, !isClosed else { return }
        let transport = transport
        let outbound = outbound
        ioTasks.append(Task {
            do {
                while !Task.isCancelled {
                    self.handle(try await transport.receive())
                }
            } catch {
                self.shutDown(error)
            }
        })
        ioTasks.append(Task {
            do {
                for await text in outbound {
                    try await transport.send(text)
                }
            } catch {
                self.shutDown(error)
            }
        })
    }

    // MARK: Requests

    public struct ReceivedResponse: Sendable {
        public var value: JSONValue
        public var frame: Int
    }

    /// Sends a request and waits for its result. Throws `JSONRPCError` when the gateway
    /// answers with an error.
    public func request(
        _ method: String,
        params: JSONValue = .object([:]),
        timeout: Duration? = nil
    ) async throws -> JSONValue {
        try await requestWithReceipt(method, params: params, timeout: timeout).value
    }

    /// Returns the response's original socket position, even if consuming the
    /// inbound stream and resuming the caller are scheduled in a different order.
    public func requestWithReceipt(
        _ method: String, params: JSONValue = .object([:]), timeout: Duration? = nil
    ) async throws -> ReceivedResponse {
        try Task.checkCancellation()
        let (id, text) = try frame(method, params)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue(id, text, method: method, timeout: timeout) { continuation.resume(with: $0) }
            }
        } onCancel: {
            Task { await self.fail(id, with: CancellationError()) }
        }
    }

    /// Sends a request without waiting for its result, which goes to `answered`, once: a
    /// `JSONRPCError` when the gateway answers with an error. The frame is queued before
    /// this returns, so whatever is sent after it leaves after it.
    public func request(
        _ method: String,
        params: JSONValue = .object([:]),
        timeout: Duration? = nil,
        answered: @escaping @Sendable (Result<JSONValue, any Error>) -> Void
    ) throws {
        let (id, text) = try frame(method, params)
        queue(id, text, method: method, timeout: timeout) { answered($0.map(\.value)) }
    }

    /// `request` with typed params and result.
    public func call<Output: Decodable & Sendable>(
        _ method: String,
        _ params: some Encodable & Sendable,
        returning: Output.Type = Output.self,
        timeout: Duration? = nil
    ) async throws -> Output {
        let result = try await request(method, params: JSONValue(encoding: params), timeout: timeout)
        return try result.decode(Output.self)
    }

    // MARK: Answering the gateway

    /// Answers a server→client request.
    public func respond(to requestID: String, result: JSONValue) throws {
        try send(["jsonrpc": "2.0", "id": .string(requestID), "result": result])
    }

    /// Declines a server→client request. Use `JSONRPCError.methodNotFoundCode` for a
    /// method this client does not implement, so the agent fails fast instead of waiting.
    public func reject(_ requestID: String, code: Int, message: String) throws {
        try send([
            "jsonrpc": "2.0",
            "id": .string(requestID),
            "error": ["code": .number(Double(code)), "message": .string(message)],
        ])
    }

    // MARK: Liveness

    /// Starts the `gateway.ping` keepalive. Call after `gateway.ready` advertises it.
    public func startHeartbeat() {
        guard heartbeatTask == nil, !isClosed else { return }
        lastInbound = .now
        heartbeatTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: options.heartbeatInterval)
                if Task.isCancelled || isClosed { return }
                if ContinuousClock.now - lastInbound >= options.heartbeatDeadline {
                    shutDown(JSONRPCPeerError.heartbeatTimedOut)
                    return
                }
                ping()
            }
        }
    }

    /// Checks the socket at once, outside the heartbeat's rhythm, as after the device's way
    /// onto the network changed: sends `gateway.ping`, and closes the socket as gone quiet
    /// (`heartbeatTimedOut`) when nothing at all arrives within `deadline`, measured on
    /// `clock`. Any frame will do, as for the heartbeat: the answer waits behind whatever
    /// the gateway sent before it. False when the socket was closed, by this or before it.
    public func checkAlive(within deadline: Duration, on clock: any Clock<Duration> = ContinuousClock()) async -> Bool {
        guard !isClosed else { return false }
        let received = framesReceived
        ping()
        try? await clock.sleep(for: deadline)
        // Let go of meanwhile: whoever did so decides about the socket.
        if Task.isCancelled { return !isClosed }
        guard !isClosed else { return false }
        guard framesReceived == received else { return true }
        shutDown(JSONRPCPeerError.heartbeatTimedOut)
        return false
    }

    /// Closes the socket and fails every pending request.
    public func close() {
        shutDown(nil)
    }

    /// Closes the socket for `reason`, which `closeError` then gives, and fails every
    /// pending request with it.
    public func close(because reason: any Error) {
        shutDown(reason)
    }

    // MARK: Internals

    private func send(_ frame: JSONValue) throws {
        if isClosed { throw closeError ?? JSONRPCPeerError.closed }
        let text = try frame.serialized()
        try transport.checkCarries(text)
        outboundContinuation.yield(text)
    }

    /// A request's id and frame.
    private func frame(_ method: String, _ params: JSONValue) throws -> (id: String, text: String) {
        if isClosed { throw closeError ?? JSONRPCPeerError.closed }
        requestNumber += 1
        let id = "r\(requestNumber)"
        let text = try JSONValue.object([
            "jsonrpc": "2.0",
            "id": .string(id),
            "method": .string(method),
            "params": params,
        ]).serialized()
        // One the socket would not carry fails alone, and the connection stays up.
        try transport.checkCarries(text)
        return (id, text)
    }

    /// Sends a request's frame, its result to go to `answered`, or the time-out once it is
    /// past.
    private func queue(
        _ id: String, _ text: String, method: String, timeout: Duration?,
        answered: @escaping @Sendable (Result<ReceivedResponse, any Error>) -> Void
    ) {
        let limit = timeout ?? options.requestTimeout
        let timeoutTask = Task {
            try? await Task.sleep(for: limit)
            if !Task.isCancelled {
                self.fail(id, with: JSONRPCPeerError.timedOut(method: method))
            }
        }
        pending[id] = Pending(answered: answered, timeout: timeoutTask)
        outboundContinuation.yield(text)
    }

    /// A `gateway.ping`, whose answer is not waited for: what tells is that anything arrives.
    private func ping() {
        heartbeatNumber += 1
        try? send([
            "jsonrpc": "2.0",
            "id": .string("heartbeat-\(heartbeatNumber)"),
            "method": "gateway.ping",
            "params": [:],
        ])
    }

    private func handle(_ text: String) {
        lastInbound = .now
        framesReceived += 1
        // A frame that is not JSON is skipped; the connection stays up.
        let frame: InboundFrame
        do {
            frame = try InboundFrame.parse(text)
        } catch let error as LeanDeltaFormatError {
            Self.log.warning("A compact delta could not be read. Reconnecting for canonical replay.")
            shutDown(error)
            return
        } catch {
            return
        }
        switch frame {
        case let .response(id, outcome):
            // Heartbeat pongs arrive here with no pending entry.
            guard let entry = pending.removeValue(forKey: id) else { return }
            entry.timeout.cancel()
            entry.answered(outcome.map { ReceivedResponse(value: $0, frame: framesReceived) }.mapError { $0 as any Error })
        case var .serverRequest(request):
            request.receivedAtFrame = framesReceived
            inboundContinuation.yield(.request(request))
        case var .event(event):
            event.receivedAtFrame = framesReceived
            inboundContinuation.yield(.event(event))
        case .unrecognized:
            Self.log.debug("An unrecognized gateway frame was ignored.")
        }
    }

    private func fail(_ id: String, with error: any Error) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.timeout.cancel()
        entry.answered(.failure(error))
    }

    private func shutDown(_ error: (any Error)?) {
        guard !isClosed else { return }
        isClosed = true
        closeError = error
        heartbeatTask?.cancel()
        ioTasks.forEach { $0.cancel() }
        outboundContinuation.finish()
        transport.close()

        let failure = error ?? JSONRPCPeerError.closed
        for entry in pending.values {
            entry.timeout.cancel()
            entry.answered(.failure(failure))
        }
        pending.removeAll()
        inboundContinuation.finish()
    }
}
