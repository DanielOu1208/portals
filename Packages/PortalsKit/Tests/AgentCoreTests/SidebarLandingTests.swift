import Foundation
import Testing
@testable import AgentCore

@Suite struct SidebarLandingTests {
    private let middles: [CGFloat?] = [22, 68, 114, 160, 206]

    @Test func theHoldOnlyAppliesAtTheBoundaryBetweenAdjacentSlots() {
        #expect(SidebarLanding.slot(at: 69, middles: middles, previous: 1, hold: 2) == 1)
        #expect(SidebarLanding.slot(at: 70, middles: middles, previous: 1, hold: 2) == 2)
        #expect(SidebarLanding.slot(at: 67, middles: middles, previous: 2, hold: 2) == 2)
        #expect(SidebarLanding.slot(at: 66, middles: middles, previous: 2, hold: 2) == 1)
    }

    @Test func aJumpAcrossSeveralSlotsDoesNotKeepADistantLanding() {
        #expect(SidebarLanding.slot(at: 236, middles: middles, previous: nil, hold: 2) == 5)
        // A fast jump from the bottom to just above the first middle lands at the top.
        #expect(SidebarLanding.slot(at: 21, middles: middles, previous: 5, hold: 2) == 0)
        // And the same jump downward lands below the last row.
        #expect(SidebarLanding.slot(at: 207, middles: middles, previous: 0, hold: 2) == 5)
    }

    @Test func anUnmeasuredSuffixKeepsItsPlaceAfterTheMeasuredRows() {
        let rows = ["a", "b", "c", "d"]
        let slot = SidebarLanding.slot(at: 92, middles: [22, 68, nil, nil], previous: nil, hold: 2)
        #expect(slot == 2)
        #expect(SidebarOrder.moving("a", before: rows[slot], in: rows) == ["b", "a", "c", "d"])
        // Only a measurement of the actual last row can put a row after all siblings.
        #expect(SidebarLanding.slot(at: 184, middles: [nil, nil, 114, 160], previous: nil, hold: 2) == 4)
    }

    @Test func unmeasuredRowsBeforeOrBetweenTargetsDoNotChangeTheirLogicalIndices() {
        #expect(SidebarLanding.slot(at: 100, middles: [nil, nil, 114, 160], previous: nil, hold: 2) == 2)
        #expect(SidebarLanding.slot(at: 100, middles: [22, nil, 114, nil], previous: nil, hold: 2) == 2)
    }
}
