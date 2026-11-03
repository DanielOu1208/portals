import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// A bridge's `agent_threads`: the listing's `shared`, `thread.mark` `shared`, and a
/// `request.cancel` that says who answered for the user.
@Suite struct AgentThreadsWireTests {
    private static let row: JSONValue = [
        "id": "review", "agent": "codex", "updated": 1_791_324_000, "revision": 9,
        "started_by": ["name": "Claude Code", "thread": "parent"], "shared": true,
    ]

    @Test func theListingSaysWhichOnesAreInTheSidebarToo() throws {
        let listed = try #require(BridgeWire.listedThread(from: Self.row))
        #expect(listed.shared)
        #expect(listed.startedBy == ThreadStarter(name: "Claude Code", thread: ThreadRef.ID(rawValue: "parent")))
        var plain = Self.row
        if case var .object(fields) = plain {
            fields["shared"] = nil
            plain = .object(fields)
        }
        #expect(try #require(BridgeWire.listedThread(from: plain)).shared == false)
    }

    @Test func theMarkIsSentOnlyWhenGiven() throws {
        let shown = try JSONValue(encoding: BridgeWire.ThreadMarkParams(thread: "review", marks: ThreadMarks(shared: true)))
        #expect(shown == ["thread": "review", "shared": true])
        let pinned = try JSONValue(encoding: BridgeWire.ThreadMarkParams(thread: "review", marks: ThreadMarks(pinned: true)))
        #expect(pinned["shared"] == nil)
    }

    /// net-20: the listing's `turn`, and a seen that names it; neither from or to an older
    /// bridge's listing.
    @Test func theListingSaysItsLatestTurnAndASeenNamesTheTurnItIsOf() throws {
        var row = Self.row
        if case var .object(fields) = row {
            fields["turn"] = 7
            row = .object(fields)
        }
        #expect(try #require(BridgeWire.listedThread(from: row)).turn == 7)
        #expect(try #require(BridgeWire.listedThread(from: Self.row)).turn == nil)
        let seen = try JSONValue(encoding: BridgeWire.ThreadMarkParams(thread: "review", marks: ThreadMarks(unseen: false, revision: 9, list: "l", turn: 7)))
        #expect(seen == ["thread": "review", "unseen": false, "revision": 9, "list": "l", "turn": 7])
    }

    private static func cancel(_ payload: JSONValue) -> GatewayEvent {
        GatewayEvent(type: "request.cancel", sessionID: "run-1", payload: payload)
    }

    private static let features: Set<String> = [BridgeWire.Feature.threadSync, BridgeWire.Feature.agentThreads]

    @Test func aCardAnsweredByTheAgentThatStartedTheThreadSaysWhoAndWhat() {
        let allowed = Self.cancel(["id": "srq-1", "reason": "resolved", "by": "Claude Code", "answer": ["choice": "session"]])
        #expect(HermesEventMapper.threadEvents(for: allowed, features: Self.features) == [.requestAnswered(id: "srq-1", answer: .approval(.session), by: "Claude Code")])

        let denied = Self.cancel(["id": "srq-1", "reason": "resolved", "by": "Claude Code", "answer": ["choice": "deny", "note": " Use the fake bridge. "]])
        #expect(HermesEventMapper.threadEvents(for: denied, features: Self.features) == [.requestAnswered(id: "srq-1", answer: .declined(note: "Use the fake bridge."), by: "Claude Code")])

        let answered = Self.cancel(["id": "srq-2", "reason": "resolved", "by": "Claude Code", "answer": ["answers": ["q0": "Swift", "q1": nil]]])
        #expect(HermesEventMapper.threadEvents(for: answered, features: Self.features) == [.requestAnswered(id: "srq-2", answer: .clarify(["q0": "Swift"]), by: "Claude Code")])

        // An answer that cannot be read still says who gave it.
        let odd = Self.cancel(["id": "srq-3", "reason": "resolved", "by": "Claude Code", "answer": ["choice": "maybe"]])
        #expect(HermesEventMapper.threadEvents(for: odd, features: Self.features) == [.requestClosed(id: "srq-3", reason: "Answered by Claude Code")])
    }

    @Test func anyOtherCancelReadsAsBefore() {
        let elsewhere = Self.cancel(["id": "srq-1", "reason": "resolved"])
        #expect(HermesEventMapper.threadEvents(for: elsewhere, features: Self.features) == [.requestClosed(id: "srq-1", reason: "Answered elsewhere")])
        // Without the feature, a `by` is not read.
        let unlisted = Self.cancel(["id": "srq-1", "reason": "resolved", "by": "Claude Code", "answer": ["choice": "once"]])
        #expect(HermesEventMapper.threadEvents(for: unlisted, features: [BridgeWire.Feature.threadSync]) == [.requestClosed(id: "srq-1", reason: "Answered elsewhere")])
        let withdrawn = Self.cancel(["id": "srq-1", "reason": "interrupted", "by": "Claude Code"])
        #expect(HermesEventMapper.threadEvents(for: withdrawn, features: Self.features) == [.requestClosed(id: "srq-1", reason: "Stopped before it was answered")])
    }
}
