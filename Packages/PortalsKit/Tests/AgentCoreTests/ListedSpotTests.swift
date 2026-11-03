import Foundation
import Testing
@testable import AgentCore

@Suite struct ListedSpotTests {
    @Test func aRowIsNotedOnceItIsBothLaidOutAndShownWhicheverComesFirst() {
        var laidOutFirst = ListedSpot<CGRect>()
        #expect(laidOutFirst.laidOut(at: CGRect(x: 0, y: 40, width: 300, height: 32)) == nil)
        #expect(laidOutFirst.appeared() == CGRect(x: 0, y: 40, width: 300, height: 32))

        var shownFirst = ListedSpot<CGRect>()
        #expect(shownFirst.appeared() == nil)
        #expect(shownFirst.laidOut(at: CGRect(x: 0, y: 40, width: 300, height: 32)) == CGRect(x: 0, y: 40, width: 300, height: 32))
    }

    /// The fault of 2026-10-30: a row scrolled out of sight and back, where it was, is
    /// measured at the same place and so not measured anew; it is noted again all the same.
    @Test func aRowShownAgainWhereItWasIsNotedAgain() {
        var spot = ListedSpot<CGRect>()
        _ = spot.appeared()
        #expect(spot.laidOut(at: CGRect(x: 0, y: 400, width: 300, height: 32)) != nil)
        spot.disappeared()
        #expect(spot.appeared() == CGRect(x: 0, y: 400, width: 300, height: 32))
    }

    @Test func aPlaceMeasuredOutOfSightIsKeptForWhenTheRowIsShownAndNotNotedBefore() {
        var spot = ListedSpot<CGRect>()
        _ = spot.appeared()
        _ = spot.laidOut(at: CGRect(x: 0, y: 400, width: 300, height: 32))
        spot.disappeared()
        // Rows put in above it, while it is out of sight, move it down.
        #expect(spot.laidOut(at: CGRect(x: 0, y: 480, width: 300, height: 32)) == nil)
        #expect(spot.isShown == false)
        #expect(spot.appeared() == CGRect(x: 0, y: 480, width: 300, height: 32))
    }
}
