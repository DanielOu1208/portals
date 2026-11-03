import AgentCore
import Testing
@testable import HermesBackend

/// The status line of a run a device opens whole (`session.resume` `status_line`).
@Suite struct StatusLineWireTests {
    @Test func aRunOpenedWholeShowsTheStatusLineTheHostHolds() throws {
        let line = "Compacting the conversation…"
        let resumed = try JSONValue.object([
            "session_id": "s", "running": true, "messages": [], "info": [:], "status_line": .string(line),
            "inflight": ["user": "go on", "assistant": "", "streaming": true],
        ]).decode(HermesWire.SessionResumeResult.self)
        let snapshot = HermesHistoryMapper.snapshot(from: resumed)
        #expect(snapshot.statusLine == line)
        var state = ThreadState()
        state.apply(.turnStarted)
        state.apply(.status("Claude's API did not answer; trying again (attempt 6 of 10)…"))
        state.adopt(snapshot)
        #expect(state.runStatus(replyIsArriving: false) == .note(line))

        // None held: none shown, whatever was shown before.
        var none = ThreadState()
        none.apply(.turnStarted)
        none.apply(.status("Claude's API did not answer; trying again (attempt 6 of 10)…"))
        none.adopt(HermesHistoryMapper.snapshot(from: try JSONValue.object([
            "session_id": "s", "running": true, "messages": [], "info": [:],
        ]).decode(HermesWire.SessionResumeResult.self)))
        #expect(none.runStatus(replyIsArriving: false) == .thinking)

        // At rest there is no run to say it of.
        let resting = HermesHistoryMapper.snapshot(from: try JSONValue.object([
            "session_id": "s", "running": false, "messages": [], "info": [:], "status_line": .string(line),
        ]).decode(HermesWire.SessionResumeResult.self))
        #expect(resting.statusLine == nil)
    }
}
