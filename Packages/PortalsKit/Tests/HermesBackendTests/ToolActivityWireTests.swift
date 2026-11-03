import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct ToolActivityWireTests {
    @Test func liveProgressAndUsageMapWithoutConfusingContext() {
        let progress = GatewayEvent(type: "tool.progress", payload: ["tool_id": "e", "output": "latest", "progress": "Running", "output_truncated": true])
        #expect(HermesEventMapper.threadEvents(for: progress) == [
            .toolProgress(ToolProgress(id: "e", output: "latest", progress: "Running", outputTruncated: true)),
        ])
        let usage = GatewayEvent(type: "message.usage", payload: ["turn_usage": ["tokens": 1234]])
        #expect(HermesEventMapper.threadEvents(for: usage, features: [BridgeWire.Feature.turnUsage]) == [.turnUsage(TurnSpent(tokens: 1234))])
        #expect(HermesEventMapper.threadEvents(for: usage).isEmpty)
        #expect(HermesEventMapper.threadEvents(for: GatewayEvent(type: "tool.progress", payload: [:])).isEmpty)
    }

    @Test func workingStatesStayTransientAndNoticesAreDurable() {
        for text in ["Thinking", "Running tool", "Waiting for approval", "Compacting conversation"] {
            let event = GatewayEvent(type: "status.update", payload: ["kind": "working", "text": .string(text)])
            #expect(HermesEventMapper.threadEvents(for: event) == [.status(text)])
        }
        for (kind, level) in [("info", Notice.Level.info), ("warn", .warning), ("error", .error)] {
            let event = GatewayEvent(type: "status.update", payload: ["kind": .string(kind), "text": "Hook completed"])
            #expect(HermesEventMapper.threadEvents(for: event) == [.notice(Notice(level, "Hook completed"))])
        }
    }

    @Test func reconnectRestoresActiveOutputMetadataAndLiveTokens() throws {
        let tool: JSONValue = [
            "tool_id": "e", "name": "terminal", "args": [
                "command": "npm test", "summary": "Run tests", "riskLevel": "medium", "fireAndForget": true, "timeout": 120,
            ], "output": "first\nsecond", "progress": "Testing", "output_truncated": true,
        ]
        let resumed = try JSONValue.object([
            "session_id": "s", "running": true, "messages": [],
            "inflight": ["user": "Test", "tools": .array([tool]), "turn_usage": ["tokens": 42]],
        ]).decode(HermesWire.SessionResumeResult.self)
        let snapshot = HermesHistoryMapper.snapshot(from: resumed, features: [BridgeWire.Feature.turnUsage])
        #expect(snapshot.transcript.turns.last?.footer == "42 tokens so far")
        let tools = snapshot.transcript.turns.flatMap(\.items).compactMap { item -> ToolRun? in
            if case let .tool(run) = item.content { run } else { nil }
        }
        let run = try #require(tools.first)
        #expect(run.output == "first\nsecond")
        #expect(run.progress == "Testing")
        #expect(run.outputTruncated == true)
        #expect(run.execution == ToolExecution(summary: "Run tests", riskLevel: "medium", background: true, timeout: 120))
        #expect(try JSONDecoder().decode(ToolRun.self, from: JSONEncoder().encode(run)) == run)
    }

    /// Claude Code's summary of a run of its calls, from a bridge with `status_headline`.
    @Test func aHeadlineIsReadFromABridgeThatOffersIt() {
        let event = GatewayEvent(type: "status.headline", payload: ["text": "Read a.txt and b.txt", "tool_ids": ["toolu_1", "toolu_2"]])
        let features: Set = [BridgeWire.Feature.statusHeadline]
        #expect(HermesEventMapper.threadEvents(for: event, features: features) == [.headline("Read a.txt and b.txt", toolIDs: ["toolu_1", "toolu_2"])])
        #expect(HermesEventMapper.threadEvents(for: event).isEmpty)
        #expect(HermesEventMapper.threadEvents(for: GatewayEvent(type: "status.headline", payload: ["text": " "]), features: features).isEmpty)
        let bare = GatewayEvent(type: "status.headline", payload: ["text": "Listed the folder"])
        #expect(HermesEventMapper.threadEvents(for: bare, features: features) == [.headline("Listed the folder", toolIDs: [])])
    }

    @Test func malformedStructuredTodosDoNotEraseAValidPlan() {
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: ["todos": "Malformed", "items": []]) == nil)
    }
}
