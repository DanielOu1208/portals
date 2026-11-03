import AgentCore
import Foundation
import Synchronization
import Testing
@testable import HermesBackend

/// What opening a connection waits for (`HermesConnection.open`): `gateway.ready`, and
/// from Hermes the answer to `client.capabilities`. A bridge takes a connection's frames in
/// the order they come and has applied `client.capabilities` before it reads the next
/// (bridge/src/gateway/connection.ts), so its answer is not waited for.
@Suite struct HandshakeTests {
    private static let bridgeReady: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["subagents"]]]
    private static let hermesReady: JSONValue = ["replay_epoch": "e1", "heartbeat": false]

    /// A transport the host has said `gateway.ready` on, with `payload`.
    private func ready(_ payload: JSONValue) -> ScriptedTransport {
        let transport = ScriptedTransport()
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": payload]])
        return transport
    }

    /// Opens a connection on `transport`, given up on after a few seconds.
    private func open(_ transport: ScriptedTransport, opened: Flag? = nil) -> Task<HermesConnection, any Error> {
        let opening = Task {
            let connection = try await HermesConnection.open(
                authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
                makeTransport: { _ in transport }
            )
            opened?.set()
            return connection
        }
        Task {
            try? await Task.sleep(for: .seconds(5))
            opening.cancel()
        }
        return opening
    }

    @Test func aBridgeIsNotWaitedOnForItsAnswerToTheCapabilities() async throws {
        let transport = ready(Self.bridgeReady)
        let connection = try await open(transport).value
        #expect(connection.serverRequestMethods == nil)

        // The calls that follow leave after it, without its answer.
        let listing = Task {
            try await connection.peer.call(
                HermesWire.Method.profilesList, HermesWire.ProfilesListParams(), returning: HermesWire.ProfilesListResult.self
            )
        }
        let capabilities = try await transport.expect("client.capabilities")
        #expect(capabilities["params"] == ["server_requests": true, "subagent_requests": true])
        let profiles = try await transport.expect("profiles.list")
        try transport.answer(capabilities, ["server_requests": ["approval", "clarify"]])
        try transport.answer(profiles, ["profiles": [["name": "claude"]]])
        #expect(try await listing.value.profiles?.count == 1)
        #expect(!transport.isClosed)
        await connection.peer.close()
    }

    /// A bridge is told what this app takes of what it offers, and nothing of what it does
    /// not offer: a bridge from before both features (npm 0.1.0) is sent what Hermes is.
    @Test(arguments: [
        ([], ["server_requests": true]),
        ([BridgeWire.Feature.subagents], ["server_requests": true, "subagent_requests": true]),
        ([BridgeWire.Feature.pollNow], ["server_requests": true, "poll_now": true]),
        ([BridgeWire.Feature.subagents, BridgeWire.Feature.pollNow, BridgeWire.Feature.threadSync], ["server_requests": true, "subagent_requests": true, "poll_now": true]),
    ] as [([String], JSONValue)])
    func aBridgeIsSentTheCapabilitiesOfTheFeaturesItLists(features: [String], params: JSONValue) async throws {
        let transport = ready(["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": .array(features.map(JSONValue.string))]])
        let connection = try await open(transport).value
        let capabilities = try await transport.expect("client.capabilities")
        #expect(capabilities["params"] == params)
        await connection.peer.close()
    }

    @Test func hermesIsWaitedOnForItsAnswerToTheCapabilities() async throws {
        let transport = ready(Self.hermesReady)
        let opened = Flag()
        let opening = open(transport, opened: opened)
        let capabilities = try await transport.expect("client.capabilities")
        #expect(capabilities["params"] == ["server_requests": true])
        try await Task.sleep(for: .milliseconds(50))
        #expect(!opened.isSet)

        try transport.answer(capabilities, ["server_requests": ["approval", "clarify"]])
        let connection = try await opening.value
        #expect(connection.serverRequestMethods == ["approval", "clarify"])
        await connection.peer.close()
    }

    /// A connection that could not say it answers the bridge's questions is no use: its
    /// approvals would not come here. It is closed, and the backend opens another.
    @Test func aBridgeThatRefusesTheCapabilitiesHasTheConnectionClosed() async throws {
        let transport = ready(Self.bridgeReady)
        let connection = try await open(transport).value
        try transport.fail(try await transport.expect("client.capabilities"), code: -32602, message: "No.")
        #expect(await within { await connection.peer.isClosed ? true : nil } == true)
        #expect(transport.isClosed)
    }

    /// And the connection says why in the bridge's own words, not only that it closed.
    @Test func aBridgeThatRefusesTheCapabilitiesIsShownWithItsReason() async throws {
        let transports = TransportSequence()
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transports.make() }
        )
        var states = backend.connectionStates.makeAsyncIterator()
        let connecting = Task { try await backend.connect() }
        let transport = try #require(await transports.next())
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": Self.bridgeReady]])
        try await connecting.value
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        try transport.fail(try await transport.expect("client.capabilities"), code: -32602, message: "This bridge cannot take that client.")
        let closed = await states.next()
        #expect(closed == .disconnected(reason: "This bridge cannot take that client."))
        await backend.disconnect()
    }

    /// The calls that went out behind it fail as on any lost connection, not as the
    /// bridge's answer to them: a change to the list it says no to is not sent again
    /// (HostSync), and this one it never read.
    @Test func theCallsBehindARefusedCapabilitiesFailAsOnALostConnection() async throws {
        let transports = TransportSequence()
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transports.make() }
        )
        let connecting = Task { try await backend.connect() }
        let transport = try #require(await transports.next())
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": [
            "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["subagents", "thread_sync"]],
        ]]])
        try await connecting.value
        let capabilities = try await transport.expect("client.capabilities")
        let removing = Task { try await backend.removeThread(ThreadRef.ID(rawValue: "t1")) }
        _ = try await transport.expect("thread.delete")

        try transport.fail(capabilities, code: -32602, message: "This bridge cannot take that client.")
        await #expect { try await removing.value } throws: { !($0 is ThreadSyncError) }
        await backend.disconnect()
    }

    @Test func aBackendOnABridgeListsItsAgentsWithoutWaitingForTheCapabilities() async throws {
        let transport = ready(Self.bridgeReady)
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        let connecting = Task { try await backend.connect() }
        Task {
            try? await Task.sleep(for: .seconds(5))
            connecting.cancel()
        }
        try await connecting.value
        let listing = Task { try await backend.listAgents() }
        let capabilities = try await transport.expect("client.capabilities")
        try transport.answer(try await transport.expect("profiles.list"), ["profiles": [["name": "claude"]]])
        try transport.answer(capabilities, ["server_requests": ["approval", "clarify"]])
        #expect(try await listing.value.map(\.id.name) == ["claude"])
        await backend.disconnect()
    }
}

/// Set once, from any task.
final class Flag: Sendable {
    private let value = Mutex(false)

    var isSet: Bool { value.withLock { $0 } }

    func set() {
        value.withLock { $0 = true }
    }
}
