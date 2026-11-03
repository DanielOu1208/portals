import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// A bridge's `senders`: who a message sent through the fleet is from, and who started a
/// thread through it, as facts beside the message and the listed thread; read only from a
/// bridge that offers it, the message's own line read otherwise.
@Suite struct SendersWireTests {
    private static let far: JSONValue = [
        "agent": "codex", "agent_name": "Codex", "thread": "019a", "title": "Review",
        "machine": "7d2a41c09be36f58", "machine_name": "Dana's Mac mini",
    ]
    private static let farSender = MessageSender(
        agent: "codex", agentName: "Codex", thread: "019a", title: "Review", machine: "7d2a41c09be36f58", machineName: "Dana's Mac mini"
    )
    private static let line = "[Portals: from Codex · \"Review\" (thread 7d2a41c09be36f58/019a) on Dana's Mac mini]\nLook at the diff"
    private static let features: Set<String> = [BridgeWire.Feature.turnMessages, BridgeWire.Feature.queue, BridgeWire.Feature.senders]

    @Test func aStoredMessageKeepsWhoSentItOnlyFromABridgeThatSays() throws {
        let stored: [JSONValue] = [["role": "user", "text": .string(Self.line), "timestamp": 1_791_324_000, "from": Self.far]]
        let message = try #require(HermesHistoryMapper.transcript(from: stored, features: Self.features).turns.first?.items.first.flatMap { item -> UserMessage? in
            if case let .user(message) = item.content { message } else { nil }
        })
        #expect(message.from == Self.farSender)
        #expect(message.relayed?.label() == "From Codex on Dana's Mac mini · Review")
        // The app's own name for that Mac, when it has it as a host.
        #expect(message.relayed?.label { $0 == "7d2a41c09be36f58" ? "mini" : nil } == "From Codex on mini · Review")
        // Without the feature the key is not read; the line says the same.
        let old = try #require(HermesHistoryMapper.transcript(from: stored).turns.first?.items.first.flatMap { item -> UserMessage? in
            if case let .user(message) = item.content { message } else { nil }
        })
        #expect(old.from == nil)
        #expect(old.relayed?.from == Self.farSender.withoutAgent)
    }

    @Test func aTurnOpenedOrSteeredFromElsewhereAndTheQueueSayWho() {
        let start = GatewayEvent(type: "message.start", sessionID: "s", payload: ["text": .string(Self.line), "sender": "portals", "opened_by": "portals", "from": Self.far])
        #expect(HermesEventMapper.threadEvents(for: start, features: Self.features) == [.turnOpened(by: Self.line, queueID: nil, from: Self.farSender)])
        let without = Self.features.subtracting([BridgeWire.Feature.senders])
        #expect(HermesEventMapper.threadEvents(for: start, features: without) == [.turnOpened(by: Self.line, queueID: nil, from: nil)])
        let steered = GatewayEvent(type: "message.steered", sessionID: "s", payload: ["text": .string(Self.line), "sender": "portals", "from": [:]])
        #expect(HermesEventMapper.threadEvents(for: steered, features: Self.features) == [.messageSteered(Self.line, from: MessageSender())])
        let queue = GatewayEvent(type: "queue.changed", sessionID: "s", payload: ["queued": [["id": "q1", "text": .string(Self.line), "fleet": true, "from": Self.far]]])
        guard case let .queueChanged(queued, _, _)? = HermesEventMapper.threadEvents(for: queue, features: Self.features).first else {
            Issue.record("no queue")
            return
        }
        #expect(queued.first?.from == Self.farSender)
    }

    @Test func aListedThreadStartedOnAnotherMacSaysWhichMacAndThread() throws {
        let row: JSONValue = [
            "id": "review", "agent": "codex", "updated": 1_791_324_000, "revision": 9,
            "started_by": ["name": "Codex on Dana's Mac mini", "from": Self.far],
        ]
        let listed = try #require(BridgeWire.listedThread(from: row, readsSenders: true))
        #expect(listed.startedBy == ThreadStarter(name: "Codex on Dana's Mac mini", from: Self.farSender))
        #expect(try #require(BridgeWire.listedThread(from: row)).startedBy == ThreadStarter(name: "Codex on Dana's Mac mini"))
        #expect(listed.startedBy?.caption == "Started by Codex on Dana's Mac mini")
        #expect(listed.startedBy?.caption { _ in "mini" } == "Started by Codex on mini")
    }
}

private extension MessageSender {
    /// The same facts as a line names them: a line gives no agent's profile name.
    var withoutAgent: MessageSender {
        var copy = self
        copy.agent = nil
        return copy
    }
}
