import Foundation
import Testing
@testable import AgentCore

@Suite struct EndSettlingTests {
    private let start = ContinuousClock.now

    private func at(_ milliseconds: Int) -> ContinuousClock.Instant {
        start + .milliseconds(milliseconds)
    }

    private func shown(_ settling: inout EndSettling, distance: Double, height: Double, fits: Bool = false, at now: ContinuousClock.Instant) -> Bool {
        settling.frame(distance: distance, height: height, fits: fits, at: now)
    }

    /// At the end, with the height of the frame before: shown.
    @Test func shownOnceAtTheEndAndSteady() {
        var settling = EndSettling(started: start)
        #expect(!shown(&settling, distance: 0, height: 5000, at: at(16)))
        #expect(shown(&settling, distance: 0, height: 5000, at: at(32)))
    }

    /// The first frame at the end is not enough: the turns near the end are still being
    /// laid out, and the stack's guess at their height gives way to the real one.
    @Test func notWhileTheHeightChanges() {
        var settling = EndSettling(started: start)
        #expect(!shown(&settling, distance: 0, height: 5000, at: at(16)))
        #expect(!shown(&settling, distance: 0, height: 9446, at: at(32)))
        #expect(shown(&settling, distance: 0, height: 9446, at: at(48)))
    }

    /// Short of the end (the stack's guess), it waits for the scroll to get there.
    @Test func notWhileShortOfTheEnd() {
        var settling = EndSettling(started: start)
        for frame in 1...5 {
            #expect(!shown(&settling, distance: 4446, height: 107_824, at: at(frame * 16)))
        }
        #expect(!shown(&settling, distance: 0, height: 112_270, at: at(96)))
        #expect(shown(&settling, distance: 0, height: 112_270, at: at(112)))
    }

    /// A chat that fits on its screen is all laid out already: shown at its first frame,
    /// unless nothing of it is laid out yet.
    @Test func aChatThatFitsIsShownAtOnce() {
        var settling = EndSettling(started: start)
        #expect(!shown(&settling, distance: 0, height: 0, fits: true, at: at(16)))
        #expect(shown(&settling, distance: 0, height: 420, fits: true, at: at(32)))
    }

    /// Frames before anything is laid out (no height yet) are not a chat steady at its
    /// end, fitting or not; it is shown once it has a height that holds.
    @Test func notBeforeAnythingIsLaidOut() {
        var settling = EndSettling(started: start)
        for frame in 1...4 {
            #expect(!shown(&settling, distance: 0, height: 0, at: at(frame * 16)))
        }
        #expect(!shown(&settling, distance: 0, height: 9446, at: at(80)))
        #expect(shown(&settling, distance: 0, height: 9446, at: at(96)))
    }

    /// Never blank for long: shown at the limit wherever it is.
    @Test func shownAtTheLimitWhateverHappens() {
        var settling = EndSettling(started: start)
        #expect(!shown(&settling, distance: 300, height: 1000, at: at(100)))
        #expect(!shown(&settling, distance: 200, height: 1100, at: at(399)))
        #expect(shown(&settling, distance: 100, height: 1200, at: at(400)))
    }

    /// Within a point of the end is at it; a chat shorter than its screen gives 0.
    @Test func whatNeedsAMove() {
        #expect(!EndSettling.needsMove(distance: 0))
        #expect(!EndSettling.needsMove(distance: 0.6))
        #expect(!EndSettling.needsMove(distance: -0.6))
        #expect(EndSettling.needsMove(distance: 1))
        #expect(EndSettling.needsMove(distance: -538))
    }
}
