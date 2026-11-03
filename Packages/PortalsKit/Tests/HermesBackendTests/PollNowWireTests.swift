import AgentCore
import Foundation
import Synchronization
import Testing
@testable import HermesBackend

/// Polling at once (feature `poll_now`, `BridgeWire`): a bridge that lists it is asked for
/// it in `client.capabilities`, counts as one that says when something moved
/// (`reportsMoves`), and its `poll.now`, an event with no session, is heard (`hostMoves`).
/// A bridge that does not list it, and Hermes, are never sent the key, and such an event
/// from them is dropped as every event without a session was.
@Suite struct PollNowWireTests {
    private static let pushing: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity", "thread_sync", "poll_now"]],
    ]
    /// A bridge from before the feature: it keeps the list, and says nothing of moves.
    private static let olderBridge: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity", "thread_sync", "subagents"]],
    ]
    private static let hermes: JSONValue = ["replay_epoch": "e1", "heartbeat": true]

    private static let pollNow: JSONValue = [
        "jsonrpc": "2.0", "method": "event", "params": ["type": "poll.now", "payload": ["thread_list": ["id": "3f9a1c0e7b2d4a65", "revision": 812]]],
    ]

    /// Connects to a host that says `ready`, and gives what it was sent as `client.capabilities`.
    private func connect(ready: JSONValue) async throws -> (HermesBackend, ScriptedTransport, JSONValue?) {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        // Whether it says is the first connection's to say.
        #expect(await backend.reportsMoves == nil)
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        #expect(capabilities["method"]?.stringValue == "client.capabilities")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval", "clarify"]]])
        try await connecting.value
        return (backend, transport, capabilities["params"])
    }

    /// Counts what `backend` says moved.
    private func count(_ backend: HermesBackend) -> Heard {
        let heard = Heard()
        let moves = backend.hostMoves
        Task {
            for await _ in moves {
                heard.add()
            }
        }
        return heard
    }

    @Test func aBridgeThatOffersItIsAskedForItAndEachOfItsEventsIsHeard() async throws {
        let (backend, transport, params) = try await connect(ready: Self.pushing)
        #expect(params == ["server_requests": true, "poll_now": true])
        #expect(await backend.reportsMoves == true)
        let heard = count(backend)

        transport.deliver(Self.pollNow)
        #expect(await within { heard.count == 1 ? true : nil } == true)
        // One with a session is not it: it would be a thread's, and goes there or nowhere.
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "poll.now", "session_id": "s1", "payload": [:]]])
        transport.deliver(Self.pollNow)
        #expect(await within { heard.count == 2 ? true : nil } == true)
        try await Task.sleep(for: .milliseconds(200))
        #expect(heard.count == 2)
        await backend.disconnect()
    }

    @Test func aBridgeFromBeforeItIsNotAskedAndAnEventFromItIsDropped() async throws {
        let (backend, transport, params) = try await connect(ready: Self.olderBridge)
        #expect(params == ["server_requests": true, "subagent_requests": true])
        #expect(await backend.reportsMoves == false)
        let heard = count(backend)
        transport.deliver(Self.pollNow)
        try await Task.sleep(for: .milliseconds(300))
        #expect(heard.count == 0)
        await backend.disconnect()
    }

    @Test func hermesIsNeverSentTheKeyAndAnEventFromItIsDropped() async throws {
        let (backend, transport, params) = try await connect(ready: Self.hermes)
        #expect(params == ["server_requests": true])
        #expect(await backend.reportsMoves == false)
        let heard = count(backend)
        transport.deliver(Self.pollNow)
        try await Task.sleep(for: .milliseconds(300))
        #expect(heard.count == 0)
        await backend.disconnect()
    }
}

/// How many times a host said something moved, counted from any task.
final class Heard: Sendable {
    private let value = Mutex(0)

    var count: Int { value.withLock { $0 } }

    func add() {
        value.withLock { $0 += 1 }
    }
}
