import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// What a turn spent (feature `turn_usage`): told with its end, and kept on its last
/// stored message, so every device shows the footer, after a relaunch too.
@Suite struct TurnUsageTests {
    private let features: Set<String> = [BridgeWire.Feature.turnUsage]

    @Test func theEndOfATurnSaysWhatItSpentFromABridgeThatOffersIt() {
        let end = GatewayEvent(type: "message.complete", sessionID: "s1", payload: [
            "status": "complete", "text": "Done.", "turn_usage": ["seconds": 102.4, "tokens": 52_300],
        ])
        #expect(HermesEventMapper.threadEvents(for: end, features: features) == [
            .turnFinished(.completed, finalText: "Done."), .turnSpent(TurnSpent(seconds: 102.4, tokens: 52_300)),
        ])
        // Stopped and failed turns say it too; a time alone is still worth showing.
        let stopped = GatewayEvent(type: "message.complete", sessionID: "s1", payload: ["status": "interrupted", "turn_usage": ["seconds": 3.5]])
        #expect(HermesEventMapper.threadEvents(for: stopped, features: features).last == .turnSpent(TurnSpent(seconds: 3.5)))
        // A host that does not offer it is not read, nor is what cannot be shown.
        #expect(HermesEventMapper.threadEvents(for: end) == [.turnFinished(.completed, finalText: "Done.")])
        let odd = GatewayEvent(type: "message.complete", sessionID: "s1", payload: ["status": "complete", "turn_usage": ["seconds": -1, "tokens": 0]])
        #expect(HermesEventMapper.threadEvents(for: odd, features: features) == [.turnFinished(.completed, finalText: nil)])
    }

    /// A bridge names the turn that ends (`turn`, net-20), told before its end so that
    /// what the end sets off knows it; a bridge that does not say gives none.
    @Test func theEndOfATurnNamesTheTurnAsTheListNumbersIt() {
        let end = GatewayEvent(type: "message.complete", sessionID: "s1", payload: ["status": "complete", "text": "Done.", "turn": 42])
        #expect(HermesEventMapper.threadEvents(for: end) == [.turnListed(42), .turnFinished(.completed, finalText: "Done.")])
        let stopped = GatewayEvent(type: "message.complete", sessionID: "s1", payload: ["status": "interrupted", "turn": 43])
        #expect(HermesEventMapper.threadEvents(for: stopped) == [.turnListed(43), .turnFinished(.interrupted, finalText: nil)])
        let older = GatewayEvent(type: "message.complete", sessionID: "s1", payload: ["status": "complete", "text": "Done."])
        #expect(HermesEventMapper.threadEvents(for: older) == [.turnFinished(.completed, finalText: "Done.")])
    }

    @Test func historyGivesEachEndedTurnWhatItsLastMessageSaysItSpent() {
        let messages: [JSONValue] = [
            ["role": "user", "text": "List the folder.", "timestamp": 10],
            ["role": "tool", "name": "terminal", "args": ["command": "ls"], "tool_call_id": "t1", "content": "{}", "timestamp": 12],
            ["role": "assistant", "text": "Two files.", "timestamp": 20, "turn_usage": ["seconds": 9.6, "tokens": 45_728]],
            // A turn stopped before anything was said: its opener carries it.
            ["role": "user", "text": "Now count them.", "timestamp": 30, "turn_usage": ["seconds": 1.2]],
            // One from before the feature: its time from its messages'.
            ["role": "user", "text": "And again.", "timestamp": 40],
            ["role": "assistant", "text": "Two.", "timestamp": 45],
        ]
        let turns = HermesHistoryMapper.transcript(from: messages, features: features).turns
        #expect(turns.map(\.spent) == [TurnSpent(seconds: 9.6, tokens: 45_728), TurnSpent(seconds: 1.2), nil])
        #expect(turns.map(\.footer) == ["10s · 45.7k tokens", "1s", "5s"])
        // From a host without the feature, the times come from the messages alone.
        let elsewhere = HermesHistoryMapper.transcript(from: messages).turns
        #expect(elsewhere.map(\.spent) == [nil, nil, nil])
        #expect(elsewhere[0].footer == "10s")
    }

    @Test func aTurnStillRunningInTheSnapshotSaysNothingSpent() throws {
        let resumed = try JSONValue.object([
            "session_id": "s1", "running": true, "inflight": ["user": "Go on.", "assistant": "Working"],
            "messages": [["role": "user", "text": "Go on.", "timestamp": 10, "turn_usage": ["seconds": 2]]],
        ]).decode(HermesWire.SessionResumeResult.self)
        let snapshot = HermesHistoryMapper.snapshot(from: resumed, features: features)
        let turn = try #require(snapshot.transcript.turns.last)
        #expect(turn.isRunning)
        #expect(turn.spent == nil)
        #expect(turn.footer == nil)
    }
}
