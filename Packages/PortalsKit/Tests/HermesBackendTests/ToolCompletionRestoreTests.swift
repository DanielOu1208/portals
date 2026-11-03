import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct ToolCompletionRestoreTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)
    private let output = "parity-background-complete\n"
    private let receipt = "Background process started\nStatus: Running in background"

    private func toolMessage(output: String) throws -> JSONValue {
        [
            "role": "tool", "name": "terminal", "tool_call_id": "background",
            "args": ["command": "sleep 20; printf done", "fireAndForget": true],
            "content": .string(try JSONValue.object(["output": .string(output), "exit_code": 0]).serialized()),
            "timestamp": 1_000.3,
        ]
    }

    @Test(arguments: [false, true])
    func theHostsFinalResultReplacesTheReceiptAfterPersistingAndRelaunching(completionSaved: Bool) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-tool-restore-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = ThreadKey(host: HostID(rawValue: "test"), id: ThreadRef.ID(rawValue: "background"))
        var live = ThreadState()
        live.messageSent("Start the background timer", at: t0)
        live.apply(.turnStarted, at: t0)
        live.apply(.toolStarted(ToolRun(id: "background", name: "terminal", startedAt: t0)), at: t0)
        live.apply(.toolFinished(ToolResult(id: "background", name: "terminal", succeeded: true, duration: 0.3, output: receipt)), at: t0.addingTimeInterval(0.3))
        live.apply(.turnFinished(.completed, finalText: "Timer started."), at: t0.addingTimeInterval(1))
        let itemID = try #require(live.transcript.turns.first?.items.first { if case .tool = $0.content { true } else { false } }?.id)
        if completionSaved {
            live.apply(.toolFinished(ToolResult(id: "background", name: "terminal", succeeded: true, duration: 20, output: output)), at: t0.addingTimeInterval(20))
        }
        #expect(ThreadStore(directory: directory).saveTranscript(live.transcript, for: key))
        let cached = try #require(ThreadStore(directory: directory).loadTranscript(for: key))
        var restored = ThreadState(transcript: cached)
        let resumed = try JSONValue.object([
            "session_id": "background", "running": false, "messages": [
                ["role": "user", "text": "Start the background timer", "timestamp": 1_000],
                try toolMessage(output: output),
                ["role": "assistant", "text": "Timer started.", "timestamp": 1_001],
            ],
        ]).decode(HermesWire.SessionResumeResult.self)
        restored.adopt(HermesHistoryMapper.snapshot(from: resumed))
        let tools = restored.transcript.turns.flatMap(\.items).filter { if case .tool = $0.content { true } else { false } }
        #expect(tools.count == 1)
        let item = try #require(tools.first)
        #expect(item.id == itemID)
        guard case let .tool(run) = item.content else { Issue.record("Expected the restored tool"); return }
        #expect(run.output == output)
        #expect(run.state == .succeeded)
        #expect(run.progress == nil)
        #expect(run.outputTruncated == nil)
        // History has no duration. Keep a matching final result's live timing, never
        // the old launch receipt's timing when it is being replaced by a different result.
        #expect(run.duration == (completionSaved ? 20 : nil))
        #expect(!restored.isRunning)
        #expect(ThreadStore(directory: directory).saveTranscript(restored.transcript, for: key))
        #expect(ThreadStore(directory: directory).loadTranscript(for: key) == restored.transcript)
    }

    @Test func repeatedHistoryResultsUpdateTheOriginalRowEvenAfterAnotherTurn() throws {
        let history = HermesHistoryMapper.transcript(from: [
            ["role": "user", "text": "Start the timer", "timestamp": 1_000],
            try toolMessage(output: receipt),
            ["role": "assistant", "text": "Timer started.", "timestamp": 1_001],
            ["role": "user", "text": "Another question", "timestamp": 1_002],
            ["role": "assistant", "text": "Another answer", "timestamp": 1_003],
            try toolMessage(output: output),
        ])
        let tools = history.turns.flatMap(\.items).compactMap { if case let .tool(run) = $0.content { run } else { nil } }
        #expect(history.turns.count == 2)
        #expect(tools.count == 1)
        #expect(tools.first?.output == output)
        #expect(history.turns.first?.items.contains { if case let .tool(run) = $0.content { run.output == output } else { false } } == true)
        #expect(history.turns.last?.items.contains { if case .tool = $0.content { true } else { false } } == false)
    }

    private func plainTool(id: String, command: String, output: String, at time: Double) throws -> JSONValue {
        [
            "role": "tool", "name": "terminal", "tool_call_id": .string(id),
            "args": ["command": .string(command)],
            "content": .string(try JSONValue.object(["output": .string(output), "exit_code": 0]).serialized()),
            "timestamp": .number(time),
        ]
    }

    private func toolOutputs(_ transcript: Transcript) -> [[String?]] {
        transcript.turns.map { turn in
            turn.items.compactMap { if case let .tool(run) = $0.content { run.output } else { nil } }
        }
    }

    /// Some models number their calls afresh in each answer ("call_0"), and some send no
    /// id at all: two different calls that share one are two rows, as they were before
    /// background results were joined to their launch receipt.
    @Test(arguments: ["call_0", ""])
    func callsThatShareAnIdStayTwoRows(id: String) throws {
        let messages: [JSONValue] = [
            ["role": "user", "text": "List the files", "timestamp": 1_000],
            try plainTool(id: id, command: "ls", output: "a.txt\n", at: 1_000.2),
            ["role": "assistant", "text": "One file.", "timestamp": 1_001],
            ["role": "user", "text": "And the date?", "timestamp": 1_002],
            try plainTool(id: id, command: "date", output: "Thursday\n", at: 1_002.2),
            ["role": "assistant", "text": "Thursday.", "timestamp": 1_003],
        ]
        let history = HermesHistoryMapper.transcript(from: messages)
        #expect(toolOutputs(history) == [["a.txt\n"], ["Thursday\n"]])

        // A saved copy brought in line with the same history keeps both rows too.
        var restored = ThreadState(transcript: history)
        let resumed = try JSONValue.object(["session_id": "shared-ids", "running": false, "messages": .array(messages)])
            .decode(HermesWire.SessionResumeResult.self)
        restored.adopt(HermesHistoryMapper.snapshot(from: resumed))
        #expect(toolOutputs(restored.transcript) == [["a.txt\n"], ["Thursday\n"]])
    }

    /// A background call's id used again later by a different call (a model that numbers
    /// calls afresh) leaves the background row alone and gives the new call its own row.
    @Test func aLaterCallReusingABackgroundCallsIdIsARowOfItsOwn() throws {
        var background = try toolMessage(output: output)
        if case var .object(fields) = background {
            fields["tool_call_id"] = "call_0"
            background = .object(fields)
        }
        let history = HermesHistoryMapper.transcript(from: [
            ["role": "user", "text": "Start the timer", "timestamp": 1_000],
            background,
            ["role": "assistant", "text": "Timer started.", "timestamp": 1_001],
            ["role": "user", "text": "And the date?", "timestamp": 1_002],
            try plainTool(id: "call_0", command: "date", output: "Thursday\n", at: 1_002.2),
            ["role": "assistant", "text": "Thursday.", "timestamp": 1_003],
        ])
        #expect(toolOutputs(history) == [[output], ["Thursday\n"]])
    }

    /// Once a background call's final result has joined its receipt, its id is free: the
    /// same call made again later with that id (a model that numbers calls afresh) is a
    /// row of its own in its own turn.
    @Test func aBackgroundCallsIdIsFreeAgainOnceItsResultCame() throws {
        func background(_ output: String, at time: Double) throws -> JSONValue {
            guard case var .object(fields) = try toolMessage(output: output) else { return .null }
            fields["tool_call_id"] = "call_0"
            fields["timestamp"] = .number(time)
            return .object(fields)
        }
        let history = HermesHistoryMapper.transcript(from: [
            ["role": "user", "text": "Start the timer", "timestamp": 1_000],
            try background(receipt, at: 1_000.2),
            ["role": "assistant", "text": "Timer started.", "timestamp": 1_001],
            try background(output, at: 1_001.5),
            ["role": "user", "text": "Again, please", "timestamp": 1_002],
            try background(receipt, at: 1_002.2),
            ["role": "assistant", "text": "Started again.", "timestamp": 1_003],
        ])
        #expect(toolOutputs(history) == [[output], [receipt]])
    }

    /// A saved copy whose rows share an id with an earlier call (a model that numbers calls
    /// afresh) still takes the host's final result for a background call it saved as a
    /// launch receipt, row by row, after a relaunch.
    @Test func aSavedReceiptTakesItsFinalResultWhenAnEarlierCallSharesItsId() throws {
        var live = ThreadState()
        live.messageSent("List the files", at: t0)
        live.apply(.turnStarted, at: t0)
        live.apply(.toolStarted(ToolRun(id: "call_0", name: "terminal", startedAt: t0)), at: t0)
        live.apply(.toolFinished(ToolResult(id: "call_0", name: "terminal", succeeded: true, duration: 0.2, output: "a.txt\n")), at: t0.addingTimeInterval(0.2))
        live.apply(.turnFinished(.completed, finalText: "One file."), at: t0.addingTimeInterval(1))
        let t1 = t0.addingTimeInterval(2)
        live.messageSent("Start the timer", at: t1)
        live.apply(.turnStarted, at: t1)
        live.apply(.toolStarted(ToolRun(id: "call_0", name: "terminal", startedAt: t1)), at: t1)
        live.apply(.toolFinished(ToolResult(id: "call_0", name: "terminal", succeeded: true, duration: 0.3, output: receipt)), at: t1.addingTimeInterval(0.3))
        live.apply(.turnFinished(.completed, finalText: "Timer started."), at: t1.addingTimeInterval(1))
        #expect(toolOutputs(live.transcript) == [["a.txt\n"], [receipt]])

        guard case var .object(fields) = try toolMessage(output: output) else { Issue.record("Expected an object"); return }
        fields["tool_call_id"] = "call_0"
        fields["timestamp"] = 1_002.3
        var restored = ThreadState(transcript: live.transcript)
        let resumed = try JSONValue.object([
            "session_id": "shared-background", "running": false, "messages": [
                ["role": "user", "text": "List the files", "timestamp": 1_000],
                try plainTool(id: "call_0", command: "ls", output: "a.txt\n", at: 1_000.2),
                ["role": "assistant", "text": "One file.", "timestamp": 1_001],
                ["role": "user", "text": "Start the timer", "timestamp": 1_002],
                .object(fields),
                ["role": "assistant", "text": "Timer started.", "timestamp": 1_003],
            ],
        ]).decode(HermesWire.SessionResumeResult.self)
        restored.adopt(HermesHistoryMapper.snapshot(from: resumed))
        #expect(toolOutputs(restored.transcript) == [["a.txt\n"], [output]])
    }
}
