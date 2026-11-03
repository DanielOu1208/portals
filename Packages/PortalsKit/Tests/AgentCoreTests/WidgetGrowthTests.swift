import Testing
@testable import AgentCore

@Suite struct WidgetGrowthTests {
    @Test func separateExpandCollapseInteractionsHaveNoLifetimeLimit() {
        var growth = WidgetGrowth()
        #expect(growth.record(height: 100, width: 400) == true)
        // Each tap is the user's doing: the page says so with the measurement after it.
        for _ in 0..<120 {
            #expect(growth.record(height: 200, width: 400, interacted: true) == true)
            #expect(growth.record(height: 100, width: 400, interacted: true) == true)
        }
        #expect(growth.record(height: 200, width: 400, interacted: true) == true)
        #expect(growth.contentHeight == 200)
    }

    @Test func anExpansionTheUserStartedMayGrowOverManyFrames() {
        // A tap opens a section that eases open over a few hundred milliseconds: one
        // measurement says the user did something, those of the animation after it do not.
        var growth = WidgetGrowth()
        #expect(growth.record(height: 100, width: 400) == true)
        for round in 0..<10 {
            #expect(growth.record(height: 105, width: 400, interacted: true) == true, "round \(round)")
            for height in stride(from: 110.0, through: 300, by: 10) {
                #expect(growth.record(height: height, width: 400) == true, "round \(round), \(height)")
            }
            #expect(growth.record(height: 100, width: 400, interacted: true) == true)
        }
    }

    @Test func aPageThatKeepsChangingItsOwnHeightStopsMovingTheChat() {
        // A pulsing animation, or content rebuilt every second, with nobody touching it.
        var growth = WidgetGrowth()
        #expect(growth.record(height: 100, width: 400) == true)
        var frame = 100.0, changes = 0
        for cycle in 0..<1_000 {
            for height in [150.0, 200, 150, 100] {
                if growth.record(height: height, width: 400), height != frame {
                    frame = height
                    changes += 1
                }
                #expect(growth.contentHeight == height, "cycle \(cycle)")
            }
        }
        // The frame followed for a while, then stopped: not four relayouts a cycle for as
        // long as the page is loaded. Its overflow still scrolls (`contentHeight`).
        #expect(changes <= 4 * 40)
        #expect(growth.record(height: 200, width: 400) == false)
        // The user's next tap gives it room to follow again.
        #expect(growth.record(height: 200, width: 400, interacted: true) == true)
    }

    @Test func monotonicSelfGrowthStopsButKeepsItsRealOverflowHeight() {
        var growth = WidgetGrowth()
        #expect(growth.record(height: 100, width: 400) == true)
        for height in 101...140 {
            #expect(growth.record(height: Double(height), width: 400) == true)
        }
        for height in 141...500 {
            #expect(growth.record(height: Double(height), width: 400) == false)
            #expect(growth.contentHeight == Double(height))
        }
        // Equal measurements must not replenish the allowance.
        #expect(growth.record(height: 140, width: 400) == true)
        #expect(growth.record(height: 501, width: 400) == false)
    }

    @Test func aShrinkIsFollowedButGivesNoAllowanceBackWhileWidthChangeReloadAndTheUserDo() {
        var growth = WidgetGrowth()
        #expect(growth.record(height: 100, width: 400) == true)
        for height in 101...140 { #expect(growth.record(height: Double(height), width: 400) == true) }
        #expect(growth.record(height: 141, width: 400) == false)
        // The frame shrinks with the page, which by itself earns no more growth.
        #expect(growth.record(height: 100, width: 400) == true)
        #expect(growth.record(height: 200, width: 400) == false)
        #expect(growth.contentHeight == 200)
        // Another width: a fresh allowance.
        #expect(growth.record(height: 300, width: 600) == true)
        for height in 301...340 { #expect(growth.record(height: Double(height), width: 600) == true) }
        #expect(growth.record(height: 341, width: 600) == false)
        // The user's doing: a fresh allowance.
        #expect(growth.record(height: 341, width: 600, interacted: true) == true)
        for height in 342...380 { #expect(growth.record(height: Double(height), width: 600) == true) }
        #expect(growth.record(height: 381, width: 600) == false)
        // Loaded again: a fresh start.
        growth.reset()
        #expect(growth.contentHeight == nil)
        #expect(growth.record(height: 500, width: 600) == true)
        #expect(growth.record(height: 501, width: 600) == true)
    }

    @Test func invalidMeasurementsCannotChangeContentHeightOrAllowance() {
        var growth = WidgetGrowth()
        #expect(growth.record(height: .infinity, width: 400) == false)
        #expect(growth.record(height: -1, width: 400) == false)
        #expect(growth.record(height: 100_001, width: 400) == false)
        #expect(growth.record(height: 100, width: .nan) == false)
        #expect(growth.record(height: 100, width: 0) == false)
        #expect(growth.record(height: .infinity, width: 400, interacted: true) == false)
        #expect(growth.contentHeight == nil)
        #expect(growth.record(height: 100, width: 400) == true)
    }
}
