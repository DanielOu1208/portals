import Testing
@testable import AgentCore

@Suite struct ToolElapsedTests {
    @Test func nothingForAShortCall() {
        #expect(ToolElapsed.text(0) == nil)
        #expect(ToolElapsed.text(4.9) == nil)
    }

    @Test func secondsThenMinutesThenHours() {
        #expect(ToolElapsed.text(5) == "5s")
        #expect(ToolElapsed.text(59.9) == "59s")
        #expect(ToolElapsed.text(72) == "1m 12s")
        #expect(ToolElapsed.text(3600 + 4 * 60 + 30) == "1h 4m")
    }
}
