import Foundation

public enum HermesConnectionError: Error, Sendable, Hashable {
    /// The socket opened but `gateway.ready` did not arrive in time.
    case notReady
    /// The bridge answered `client.capabilities` with an error, whose sentence this is.
    /// Not that `JSONRPCError` itself: the calls that went out behind it fail with this,
    /// and the bridge's no is to the connection, not to any of them.
    case refused(String)
}

extension HermesConnectionError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .notReady: "The host did not finish connecting."
        case let .refused(reason): reason
        }
    }
}

/// One open, handshaken connection to a `hermes serve`.
///
/// Opening does what every Hermes client must do on each connection: wait for
/// `gateway.ready`, then declare `server_requests` so approvals and clarifying questions
/// are delivered, then start the heartbeat if the backend supports it.
///
/// Hermes's answer to the declaration is waited for. A bridge's is not: it takes a
/// connection's frames in the order they come and has applied the declaration before it
/// reads the next frame (bridge/src/gateway/connection.ts, whose handler for it does all
/// it does at once), so the calls that follow it go at once, one round trip sooner.
public struct HermesConnection: Sendable {
    public let peer: JSONRPCPeer
    public let ready: HermesWire.GatewayReady
    /// The request methods this backend may send to us, as it answered
    /// `client.capabilities`; nil from a bridge, whose answer is not waited for.
    public let serverRequestMethods: [String]?

    public typealias TransportFactory = @Sendable (URLRequest) -> any WebSocketTransport

    public static func open(
        authenticator: any HermesAuthenticator,
        options: JSONRPCPeer.Options = JSONRPCPeer.Options(),
        readyTimeout: Duration = .seconds(15),
        allowLeanDeltas: Bool = true,
        makeTransport: TransportFactory = { URLSessionWebSocketTransport(request: $0) }
    ) async throws -> HermesConnection {
        try await open(
            transport: makeTransport(try await authenticator.webSocketRequest()), options: options,
            readyTimeout: readyTimeout, allowLeanDeltas: allowLeanDeltas
        )
    }

    /// As above, over a socket opened already: the relay's tunnel (`RelayTunnelTransport`),
    /// which carries the sign-in inside.
    public static func open(
        transport: any WebSocketTransport,
        options: JSONRPCPeer.Options = JSONRPCPeer.Options(),
        readyTimeout: Duration = .seconds(15),
        allowLeanDeltas: Bool = true
    ) async throws -> HermesConnection {
        let peer = JSONRPCPeer(transport: transport, options: options)
        await peer.start()
        do {
            let ready = try await awaitReady(on: peer, timeout: readyTimeout)
            var serverRequestMethods: [String]?
            if let bridge = ready.bridge {
                // A bridge is told what this app takes of what it offers: with `subagents`, that
                // it keeps a subagent's question after the turn, which the bridge then leaves
                // open; with `poll_now`, that it polls when told to. Hermes knows no such key.
                var capabilities = BridgeWire.ClientCapabilitiesParams(features: bridge.features)
                if !allowLeanDeltas { capabilities.leanDeltas = nil }
                let params = try JSONValue(encoding: capabilities)
                try await peer.request(BridgeWire.Method.clientCapabilities, params: params) { answer in
                    // A connection that could not say it answers the bridge's questions is no
                    // use: they would not come here. Closed, with the bridge's reason, it is
                    // opened again.
                    if case let .failure(error) = answer {
                        let reason = (error as? JSONRPCError).map { HermesConnectionError.refused($0.message) } ?? error
                        Task { await peer.close(because: reason) }
                    }
                }
            } else {
                let capabilities: HermesWire.ClientCapabilitiesResult = try await peer.call(
                    HermesWire.Method.clientCapabilities, HermesWire.ClientCapabilitiesParams(serverRequests: true)
                )
                serverRequestMethods = capabilities.serverRequests ?? []
            }
            if ready.supportsHeartbeat {
                await peer.startHeartbeat()
            }
            return HermesConnection(
                peer: peer,
                ready: ready,
                serverRequestMethods: serverRequestMethods
            )
        } catch {
            // Prefer the reason the socket closed (for example an auth close code) over
            // the secondary error it caused.
            let closeError = await peer.closeError
            await peer.close()
            throw closeError ?? error
        }
    }

    private static func awaitReady(on peer: JSONRPCPeer, timeout: Duration) async throws -> HermesWire.GatewayReady {
        try await withThrowingTaskGroup(of: HermesWire.GatewayReady?.self) { group in
            group.addTask {
                for await message in peer.inbound {
                    if case let .event(event) = message, event.type == HermesWire.EventType.gatewayReady {
                        return HermesWire.GatewayReady(payload: event.payload)
                    }
                }
                return nil
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                return nil
            }
            defer { group.cancelAll() }
            guard let first = try await group.next(), let ready = first else {
                throw HermesConnectionError.notReady
            }
            return ready
        }
    }
}
