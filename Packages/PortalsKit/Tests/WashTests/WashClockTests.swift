import Testing
@testable import Wash

@Suite struct WashClockTests {
    @Test func movesWithTheClockWhileRunning() {
        var clock = WashClock(time: 100)
        #expect(clock.reading(at: 10) == 100)
        #expect(abs(clock.reading(at: 10 + 1.0 / 30) - (100 + 1.0 / 30)) < 1e-9)
        #expect(abs(clock.reading(at: 10.2) - 100.2) < 1e-9)
    }

    /// Back from the background (or a covered window) mid-reply, the wash goes on from
    /// where it stopped, a frame later, instead of jumping ahead by the time it was away.
    @Test func goesOnFromWhereItStoppedAfterAPause() {
        var clock = WashClock(time: 100)
        _ = clock.reading(at: 10)
        _ = clock.reading(at: 10.2)
        let resumed = clock.reading(at: 610.2)
        #expect(abs(resumed - (100.2 + 1.0 / 30)) < 1e-9)
        #expect(abs(clock.reading(at: 610.3) - (100.3 + 1.0 / 30)) < 1e-9)
    }

    @Test func neverRunsBackwards() {
        var clock = WashClock(time: 5)
        _ = clock.reading(at: 10)
        #expect(clock.reading(at: 9) == 5)
    }
}
