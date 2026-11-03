import Foundation
import Testing
@testable import AgentCore

@Suite struct ToolActivityTests {
    @Test func aRepeatedCompletionCanReplaceAReceiptWithAnEmptyFinalResult() throws {
        var state = ThreadState()
        state.apply(.toolStarted(ToolRun(id: "background", name: "terminal")))
        let itemID = try #require(state.transcript.turns.first?.items.first?.id)
        state.apply(.toolFinished(ToolResult(id: "background", name: "terminal", succeeded: true, duration: 0.3, output: "Running in background")))
        state.apply(.turnFinished(.completed, finalText: nil))
        state.apply(.toolFinished(ToolResult(id: "background", name: "terminal", succeeded: false, duration: 20)))
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].items.count == 1)
        #expect(state.transcript.turns[0].items[0].id == itemID)
        guard case let .tool(run) = state.transcript.turns[0].items[0].content else { Issue.record("Expected tool"); return }
        #expect(run.output == nil)
        #expect(run.duration == 20)
        #expect(run.state == .failed)
        #expect(!state.isRunning)
    }

    @Test func snapshotsReplaceAndCollapseCachedDuplicateToolRowsAcrossTurns() throws {
        let original = TurnItem(.tool(ToolRun(
            id: "background", name: "terminal", output: "Launch receipt",
            state: .succeeded, duration: 0.3, progress: "Running", outputTruncated: true
        )))
        let first = Turn(outcome: .completed, items: [
            TurnItem(.user(UserMessage(text: "Start"))), original, TurnItem(.text("Started.")),
        ])
        let second = Turn(outcome: .completed, items: [
            TurnItem(.user(UserMessage(text: "Next"))), TurnItem(.tool(ToolRun(id: "background", name: "terminal"))),
            TurnItem(.text("Next answer.")),
        ])
        var state = ThreadState(transcript: Transcript(turns: [first, second]))
        var hostFirst = first
        hostFirst.items[1].content = .tool(ToolRun(
            id: "background", name: "terminal", state: .failed, duration: 20
        ))
        var hostSecond = second
        hostSecond.items.remove(at: 1)
        let snapshot = ThreadSnapshot(transcript: Transcript(turns: [hostFirst, hostSecond]))
        state.apply(.snapshot(snapshot))
        let updated = state.transcript
        state.apply(.snapshot(snapshot))
        #expect(state.transcript == updated)
        let tools = state.transcript.turns.flatMap(\.items).filter { if case .tool = $0.content { true } else { false } }
        #expect(tools.count == 1)
        let item = try #require(tools.first)
        #expect(item.id == original.id)
        guard case let .tool(run) = item.content else { Issue.record("Expected tool"); return }
        #expect(run.output == nil)
        #expect(run.duration == 20)
        #expect(run.state == .failed)
        #expect(run.progress == nil)
        #expect(run.outputTruncated == nil)
    }

    @Test func cumulativeProgressKeepsOneRowAndFinalOutputWins() throws {
        var state = ThreadState()
        state.apply(.turnStarted)
        state.apply(.toolStarted(ToolRun(id: "e", name: "terminal")))
        let itemID = state.transcript.turns[0].items[0].id
        let update = ToolProgress(id: "e", output: "one\ntwo", progress: "Running", outputTruncated: true)
        state.apply(.toolProgress(update))
        state.apply(.toolProgress(update))
        #expect(state.transcript.turns[0].items.count == 1)
        guard case let .tool(live) = state.transcript.turns[0].items[0].content else { Issue.record("Expected tool"); return }
        #expect(live.output == "one\ntwo")
        #expect(live.outputTruncated == true)
        #expect(live.progress == "Running")
        state.apply(.toolFinished(ToolResult(id: "e", name: "terminal", succeeded: true, output: "final")))
        state.apply(.toolProgress(ToolProgress(id: "e", output: "stale", progress: "Late")))
        guard case let .tool(ended) = state.transcript.turns[0].items[0].content else { Issue.record("Expected tool"); return }
        #expect(state.transcript.turns[0].items[0].id == itemID)
        #expect(ended.output == "final")
        #expect(ended.progress == nil)
        #expect(ended.outputTruncated == nil)
        state.apply(.toolProgress(ToolProgress(id: "unknown", output: "No phantom row")))
        #expect(state.transcript.turns[0].items.count == 1)
    }

    @Test func liveTokensAreReplacementsAndFinalUsageIsAuthoritative() {
        var state = ThreadState()
        state.apply(.turnUsage(TurnSpent(tokens: 20)))
        #expect(state.transcript.isEmpty)
        state.apply(.turnStarted)
        state.apply(.turnUsage(TurnSpent(tokens: 10)))
        state.apply(.turnUsage(TurnSpent(tokens: 25)))
        #expect(state.transcript.turns.last?.footer == "25 tokens so far")
        state.apply(.turnFinished(.completed, finalText: nil))
        state.apply(.turnSpent(TurnSpent(seconds: 1, tokens: 30)))
        state.apply(.turnUsage(TurnSpent(tokens: 99)))
        #expect(state.transcript.turns.last?.spent?.tokens == 30)
        #expect(state.transcript.turns.last?.footer == "1s · 30 tokens")
    }

    @Test func boundedOutputTailsReplaceEarlierOutputAndMetadataPreservesTheReceivedText() throws {
        var state = ThreadState()
        state.apply(.turnStarted)
        state.apply(.toolStarted(ToolRun(id: "tail", name: "terminal", output: "Earlier output")))
        let itemID = try #require(state.transcript.turns.last?.items.first?.id)
        for index in 0..<128 {
            let tail = "**raw stdout**\nLine \(index)"
            state.apply(.toolProgress(ToolProgress(id: "tail", output: tail, outputTruncated: true)))
            state.apply(.toolProgress(ToolProgress(id: "tail", progress: "Still running")))
            guard case let .tool(run) = state.transcript.turns.last?.items.first?.content else {
                Issue.record("Expected the existing tool row")
                return
            }
            #expect(run.output == tail)
            #expect(run.outputTruncated == true)
            #expect(state.transcript.turns.last?.items.first?.id == itemID)
            #expect(state.transcript.turns.last?.items.count == 1)
        }
        let final = String(repeating: "Complete final output\n", count: 1_000)
        state.apply(.toolFinished(ToolResult(id: "tail", name: "terminal", succeeded: true, output: final)))
        guard case let .tool(run) = state.transcript.turns.last?.items.first?.content else {
            Issue.record("Expected the final tool row")
            return
        }
        #expect(run.output == final)
        #expect(run.outputTruncated == nil)
    }
}
