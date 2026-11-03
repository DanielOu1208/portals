import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// A bridge's `recent_threads`: the listing's `recent`, `thread.mark` `recent`, and that a
/// host without the feature is taken for one that does not keep them.
@Suite struct RecentThreadsWireTests {
    private static func ready(_ features: [JSONValue]) -> JSONValue {
        ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": .array(features)]]
    }

    private func connect(ready: JSONValue) async throws -> (HermesBackend, ScriptedTransport) {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval", "clarify"]]])
        try await connecting.value
        return (backend, transport)
    }

    @Test func theListingSaysWhichOnesAreRecent() throws {
        let plain: JSONValue = ["id": "a", "agent": "claude", "updated": 1_791_324_000, "revision": 9]
        #expect(try #require(BridgeWire.listedThread(from: plain)).recent == false)
        let marked: JSONValue = ["id": "a", "agent": "claude", "updated": 1_791_324_000, "revision": 9, "recent": true]
        #expect(try #require(BridgeWire.listedThread(from: marked)).recent)
    }

    @Test func theMarkIsSentOnlyWhenGiven() throws {
        let on = try JSONValue(encoding: BridgeWire.ThreadMarkParams(thread: "a", marks: ThreadMarks(recent: true)))
        #expect(on == ["thread": "a", "recent": true])
        let off = try JSONValue(encoding: BridgeWire.ThreadMarkParams(thread: "a", marks: ThreadMarks(recent: false)))
        #expect(off == ["thread": "a", "recent": false])
        let pinned = try JSONValue(encoding: BridgeWire.ThreadMarkParams(thread: "a", marks: ThreadMarks(pinned: true)))
        #expect(pinned["recent"] == nil)
        // As a pending change gives it.
        #expect(PendingThreadChange(thread: ThreadRef.ID(rawValue: "a"), recent: true).marks == ThreadMarks(recent: true))
    }

    @Test func aHostSaysWhetherItKeepsThemOnceConnected() async throws {
        let before = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t")
        )
        #expect(await before.keepsRecentThreads == nil)

        let expected: [(JSONValue, Bool)] = [
            (Self.ready(["thread_sync", "recent_threads"]), true),
            // A bridge from before: the list, and no recent threads.
            (Self.ready(["thread_sync"]), false),
            // Nothing keeps a mark without a list to carry it.
            (Self.ready(["recent_threads"]), false),
            // Hermes.
            (["replay_epoch": "e1", "heartbeat": true], false),
        ]
        for (ready, keeps) in expected {
            let (backend, _) = try await connect(ready: ready)
            #expect(await backend.keepsRecentThreads == keeps)
            await backend.disconnect()
        }
    }

    /// A step with a bridge from before the feature sends no mark for what the device holds.
    @Test func aHostSyncStepWithABridgeFromBeforeSendsNoMark() async throws {
        let (backend, transport) = try await connect(ready: Self.ready(["activity", "thread_sync"]))
        let store = ThreadStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("portals-wire-\(UUID().uuidString)"))
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let mac = HostID(rawValue: "mac")
        let thread = ThreadRef.ID(rawValue: "a")
        let list = ThreadListRevision(id: "l", revision: 5)
        store.saveSync(HostSyncState(list: list), for: mac)
        let steps = await MainActor.run {
            let steps = HostSync(host: mac, store: store, remote: backend)
            steps.heldRecent = { [thread] }
            return steps
        }
        let step = await steps.step(listNow: list)
        #expect(step.error == nil && !step.merged)
        #expect(await MainActor.run { steps.keepsRecent } == false)
        // Nothing went out for it: the next thing sent is whatever is asked next.
        let listing = Task { try await backend.listAgents() }
        let next = try #require(await transport.nextSentRequest())
        #expect(next["method"] == "profiles.list")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
        _ = try await listing.value
        await backend.disconnect()
    }
}
