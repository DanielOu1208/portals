import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// A command an agent left running in the background, as a bridge with
/// `background_commands` tells it: a row of the subagents line with its output so far.
@Suite struct BackgroundCommandWireTests {
    @Test func aCommandRowCarriesItsKindAndOutput() throws {
        let entry: JSONValue = [
            "subagent_id": "exec-1", "kind": "command", "goal": "npm run dev", "status": "running", "turn": 3,
            "started_at": 100, "background": true, "can_stop": true, "summary": "ready in 412 ms",
            "output": "> dev\nready in 412 ms\n", "output_truncated": true,
        ]
        let command = try #require(HermesEventMapper.subagent(entry))
        #expect(command.kind == .command)
        #expect(command.title == "npm run dev")
        #expect(command.summary == "ready in 412 ms")
        #expect(command.output == "> dev\nready in 412 ms\n")
        #expect(command.outputTruncated)
        #expect(command.canStop)
        // A kind this app does not know is an agent, as before.
        let other = try #require(HermesEventMapper.subagent(["subagent_id": "x", "kind": "something", "goal": "g", "status": "running"]))
        #expect(other.kind == .agent)
        #expect(other.output == nil)
        #expect(!other.outputTruncated)
        #expect(Subagent(id: "c", goal: "", kind: .command).title == "A command")
    }
}
