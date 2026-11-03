import AgentCore
import Testing
@testable import HermesBackend

@Suite struct ContextEstimateWireTests {
    @Test func contextEstimatesMapLiveAndInSnapshotsWhileOldUsageStillWorks() throws {
        let usage: JSONValue = ["context_used": 48_000, "context_max": 200_000, "context_estimated": true]
        let expected = ContextUsage(used: 48_000, limit: 200_000, estimated: true)
        #expect(HermesEventMapper.threadEvents(for: GatewayEvent(type: "session.usage", payload: ["usage": usage])) == [.contextChanged(expected)])
        #expect(HermesEventMapper.contextUsage(["context_used": 12, "context_max": 100])?.estimated == false)
        let resumed = try JSONValue.object(["session_id": "s", "messages": [], "info": ["usage": usage]]).decode(HermesWire.SessionResumeResult.self)
        #expect(HermesHistoryMapper.snapshot(from: resumed).context == expected)
    }
}
