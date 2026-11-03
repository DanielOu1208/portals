import Foundation
import Testing
@testable import AgentCore

@Suite struct ContextEstimateTests {
    @Test func oldSavedContextStillLoadsAndEstimatesSurviveSaving() throws {
        let old = try JSONDecoder().decode(ContextUsage.self, from: Data(#"{"used":100,"limit":200}"#.utf8))
        #expect(!old.estimated)
        #expect(old.fraction == 0.5)
        let estimate = ContextUsage(used: 100, limit: 200, estimated: true)
        #expect(try JSONDecoder().decode(ContextUsage.self, from: JSONEncoder().encode(estimate)) == estimate)
    }

    @Test func liveEstimatesAndACompactionKeepContextSeparateFromTurnTokens() {
        var state = ThreadState()
        state.apply(.turnStarted)
        state.apply(.turnUsage(TurnSpent(tokens: 2500)))
        state.apply(.contextChanged(ContextUsage(used: 100_000, limit: 200_000, estimated: true)))
        state.apply(.compacted(Compaction(.manual)))
        state.apply(.contextChanged(ContextUsage(used: 10_000, limit: 200_000, estimated: true)))
        #expect(state.context?.used == 10_000)
        #expect(state.context?.estimated == true)
        #expect(state.transcript.turns.last?.spent?.tokens == 2500)
    }
}
