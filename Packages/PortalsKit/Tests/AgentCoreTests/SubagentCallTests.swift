import Foundation
import Testing
@testable import AgentCore

/// A call the agent made about the agents it set to work, other than starting one, is one
/// short line naming them.
@Suite struct SubagentCallTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    @Test func eachCallSaysWhatItDidByTheirNames() {
        #expect(SubagentCall(.wait, agents: ["Darwin", "Euclid"]).words(running: false) == "Waited for Darwin and Euclid")
        #expect(SubagentCall(.wait, agents: ["Darwin", "Euclid"]).words(running: true) == "Waiting for Darwin and Euclid")
        #expect(SubagentCall(.close, agents: ["Darwin"]).words(running: false) == "Closed Darwin")
        #expect(SubagentCall(.message, agents: ["Euclid"]).words(running: false) == "Sent Euclid a message")
        #expect(SubagentCall(.followUp, agents: ["Euclid"]).words(running: false) == "Gave Euclid more to do")
        #expect(SubagentCall(.resume, agents: ["Hume"]).words(running: false) == "Resumed Hume")
        #expect(SubagentCall(.interrupt, agents: ["Hume"]).words(running: true) == "Stopping Hume")
        #expect(SubagentCall(.list).words(running: false) == "Looked at the agents")
        // Named by nobody.
        #expect(SubagentCall(.wait).words(running: false) == "Waited for the agents")
        #expect(SubagentCall(.close).words(running: false) == "Closed an agent")
    }

    @Test func manyNamesAreCountedPastTheThird() {
        #expect(SubagentCall.list([]) == nil)
        #expect(SubagentCall.list(["Darwin"]) == "Darwin")
        #expect(SubagentCall.list(["Darwin", "Euclid", "Hume"]) == "Darwin, Euclid and Hume")
        #expect(SubagentCall.list(["Darwin", "Euclid", "Hume", "Noether"]) == "Darwin, Euclid and 2 more")
    }

    /// A wait that comes to name more as it ends (those that ended while it waited, or a
    /// nickname learnt meanwhile) shows what its end says.
    @Test func theRowTakesTheNamesItsEndGives() {
        var state = ThreadState()
        state.messageSent("Wait for them", at: t0)
        state.apply(.toolStarted(ToolRun(id: "w1", name: "delegate_task", startedAt: t0, subagentCall: SubagentCall(.wait, agents: ["pear reply"]))), at: t0)
        state.apply(.toolFinished(ToolResult(id: "w1", name: "delegate_task", succeeded: true, duration: 2, subagentCall: SubagentCall(.wait, agents: ["Darwin"]))), at: t0)
        let runs = state.transcript.turns.flatMap(\.items).compactMap { item -> ToolRun? in if case let .tool(run) = item.content { run } else { nil } }
        #expect(runs.map(\.subagentCall) == [SubagentCall(.wait, agents: ["Darwin"])])
        #expect(runs.map(\.state) == [.succeeded])
        // One whose start was missed is shown from its end alone, as such.
        state.apply(.toolFinished(ToolResult(id: "c1", name: "delegate_task", succeeded: true, subagentCall: SubagentCall(.close, agents: ["Darwin"]))), at: t0)
        let last = state.transcript.turns.last?.items.last
        guard case let .tool(closed)? = last?.content else {
            Issue.record("The close is not shown")
            return
        }
        #expect(closed.subagentCall == SubagentCall(.close, agents: ["Darwin"]))
    }

    @Test func aSavedTranscriptKeepsTheCallAndOneSavedBeforeReadsWithout() throws {
        let run = ToolRun(id: "w1", name: "delegate_task", state: .succeeded, startedAt: t0, subagentCall: SubagentCall(.wait, agents: ["Darwin"]))
        let decoded = try JSONDecoder().decode(ToolRun.self, from: JSONEncoder().encode(run))
        #expect(decoded == run)
        let older = Data(#"{"id":"w1","name":"delegate_task","label":"wait","state":"succeeded","startedAt":0}"#.utf8)
        #expect(try JSONDecoder().decode(ToolRun.self, from: older).subagentCall == nil)
    }
    /// A thread seen before the app showed Codex's waits as a line keeps its turns from
    /// its saved copy; read back from a host that names them, its waits become the line,
    /// with the times this copy knows. One this copy names keeps its names.
    @Test func aSavedTurnTakesTheHostsCallsWhereItHasNone() {
        let ask = TurnItem(.user(UserMessage(text: "Wait for them", sentAt: t0, delivery: .started)))
        let saved = Turn(startedAt: t0, endedAt: t0, outcome: .completed, items: [
            ask,
            TurnItem(.tool(ToolRun(id: "w1", name: "delegate_task", label: "wait", output: "Done.", state: .succeeded, startedAt: t0, duration: 4))),
            TurnItem(.tool(ToolRun(id: "w2", name: "delegate_task", state: .succeeded, startedAt: t0, duration: 1, subagentCall: SubagentCall(.wait)))),
            TurnItem(.tool(ToolRun(id: "w3", name: "delegate_task", state: .succeeded, startedAt: t0, subagentCall: SubagentCall(.wait, agents: ["Gauss"])))),
            TurnItem(.text("Both answered.")),
        ])
        let host = Turn(startedAt: t0, endedAt: t0, outcome: .completed, items: [
            ask,
            TurnItem(.tool(ToolRun(id: "w1", name: "delegate_task", state: .succeeded, startedAt: t0, subagentCall: SubagentCall(.wait, agents: ["Gauss", "Huygens"])))),
            TurnItem(.tool(ToolRun(id: "w2", name: "delegate_task", state: .succeeded, startedAt: t0, subagentCall: SubagentCall(.wait, agents: ["Huygens"])))),
            TurnItem(.tool(ToolRun(id: "w3", name: "delegate_task", state: .succeeded, startedAt: t0, subagentCall: SubagentCall(.wait, agents: ["pear"])))),
            TurnItem(.text("Both answered.")),
        ])
        let merged = Transcript(turns: [saved]).merged(withHost: Transcript(turns: [host]))
        let runs = merged.turns.flatMap(\.items).compactMap { item -> ToolRun? in if case let .tool(run) = item.content { run } else { nil } }
        #expect(runs.map(\.subagentCall) == [SubagentCall(.wait, agents: ["Gauss", "Huygens"]), SubagentCall(.wait, agents: ["Huygens"]), SubagentCall(.wait, agents: ["Gauss"])])
        #expect(runs.map(\.label) == [nil, nil, nil])
        #expect(runs.map(\.output) == [nil, nil, nil])
        #expect(runs.map(\.duration) == [4, 1, nil])
        #expect(merged.turns.map(\.id) == [saved.id])
    }
}
