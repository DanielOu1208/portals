import Testing
@testable import AgentCore

@Suite struct StuckSwipeTests {
    /// The wait, to the microsecond.
    private func wait(_ step: StuckSwipe.Step) -> Double? {
        if case let .wait(seconds) = step { (seconds * 1e6).rounded() / 1e6 } else { nil }
    }

    @Test func aSwipeThatJustMovedIsLookedAtAgainWhenItWouldBeStuck() {
        #expect(StuckSwipe.step(still: 0, fingerDown: false) == .wait(0.35))
        #expect(wait(StuckSwipe.step(still: 0.1, fingerDown: false)) == 0.25)
    }

    @Test func aQuarterSecondAndABitWithoutAMoveSettlesIt() {
        #expect(StuckSwipe.step(still: 0.35, fingerDown: false) == .settle)
        #expect(StuckSwipe.step(still: 3, fingerDown: false) == .settle)
    }

    @Test func aFingerRestingMidSwipeIsGivenLonger() {
        #expect(wait(StuckSwipe.step(still: 0.35, fingerDown: true)) == 1.2)
        #expect(wait(StuckSwipe.step(still: 1, fingerDown: true)) == 0.55)
        #expect(StuckSwipe.step(still: 1.55, fingerDown: true) == .settle)
    }

    @Test func aClockThatWentBackIsNoReasonToWaitLonger() {
        #expect(StuckSwipe.step(still: -5, fingerDown: false) == .wait(0.35))
    }
}
