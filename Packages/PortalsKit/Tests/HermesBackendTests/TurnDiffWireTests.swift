import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// What a turn changed (feature `turn_diff`): told with its end, and kept on its last
/// stored message, so every device shows it, after a relaunch too.
@Suite struct TurnDiffWireTests {
    private let features: Set<String> = [BridgeWire.Feature.turnDiff]
    private let wire: JSONValue = [
        "files": [
            ["path": "src/app.ts", "status": "modified", "added": 3, "removed": 2, "diff": "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n"],
            ["path": "notes.md", "status": "added", "added": 2, "removed": 0, "diff": "", "cut": true],
            // Without a path it names nothing; an odd status is a change.
            ["status": "added", "added": 1],
            ["path": "old.ts", "status": "renamed", "diff": "--- a/old.ts\n+++ b/old.ts\n-x\n-y\n"],
        ],
        "added": 5, "removed": 4, "cut": true,
    ]

    @Test func theEndOfATurnSaysWhatItChangedFromABridgeThatOffersIt() throws {
        let end = GatewayEvent(type: "message.complete", sessionID: "s1", payload: ["status": "complete", "text": "Done.", "turn_diff": wire])
        let events = HermesEventMapper.threadEvents(for: end, features: features)
        #expect(events.first == .turnFinished(.completed, finalText: "Done."))
        guard case let .turnChanged(diff) = try #require(events.last) else {
            Issue.record("no turnChanged")
            return
        }
        #expect(diff.files.map(\.path) == ["src/app.ts", "notes.md", "old.ts"])
        #expect(diff.files.map(\.status) == [.modified, .added, .modified])
        // Counts the bridge left out are counted from the diff.
        #expect(diff.files[2].added == 0)
        #expect(diff.files[2].removed == 2)
        #expect(diff.files[1].cut)
        #expect(diff.cut)
        #expect(diff.added == 5)
        #expect(diff.removed == 4)
        // A host that does not offer it is not read; one that names no file says nothing.
        #expect(HermesEventMapper.threadEvents(for: end) == [.turnFinished(.completed, finalText: "Done.")])
        let none = GatewayEvent(type: "message.complete", sessionID: "s1", payload: ["status": "complete", "turn_diff": ["files": []]])
        #expect(HermesEventMapper.threadEvents(for: none, features: features) == [.turnFinished(.completed, finalText: nil)])
    }

    @Test func historyGivesEachEndedTurnWhatItsLastMessageSaysItChanged() {
        let messages: [JSONValue] = [
            ["role": "user", "text": "Fix it.", "timestamp": 10],
            ["role": "tool", "name": "patch", "args": ["path": "src/app.ts"], "tool_call_id": "t1", "content": "{}", "timestamp": 12],
            ["role": "assistant", "text": "Fixed.", "timestamp": 20, "turn_diff": wire],
            ["role": "user", "text": "Thanks.", "timestamp": 30],
            ["role": "assistant", "text": "Welcome.", "timestamp": 35],
        ]
        let turns = HermesHistoryMapper.transcript(from: messages, features: features).turns
        #expect(turns.map { $0.diff?.files.count } == [3, nil])
        // From a host without the feature, nothing.
        #expect(HermesHistoryMapper.transcript(from: messages).turns.map(\.diff) == [nil, nil])
    }

    @Test func aTurnStillRunningInTheSnapshotSaysNothingChanged() throws {
        let resumed = try JSONValue.object([
            "session_id": "s1", "running": true, "inflight": ["user": "Go on.", "assistant": "Working"],
            "messages": [["role": "user", "text": "Go on.", "timestamp": 10, "turn_diff": wire]],
        ]).decode(HermesWire.SessionResumeResult.self)
        let snapshot = HermesHistoryMapper.snapshot(from: resumed, features: features)
        let turn = try #require(snapshot.transcript.turns.last)
        #expect(turn.isRunning)
        #expect(turn.diff == nil)
    }
}
