import Foundation
import Testing
@testable import AgentCore

@Suite struct SidebarSplitTests {
    private let split = SidebarSplit(room: 600, topMinimum: 80, bottomMinimum: 130)

    @Test func notSetItHugsItsRowsUpToHalfTheRoom() {
        #expect(split.height(share: nil, rows: 120) == 120)
        #expect(split.height(share: nil, rows: 300) == 300)
        #expect(split.height(share: nil, rows: 900) == 300)
    }

    @Test func notSetItIsHowItWasOnAShortWindowToo() {
        // As before the divider could be dragged: half, whatever the minimums.
        let short = SidebarSplit(room: 200, topMinimum: 80, bottomMinimum: 130)
        #expect(short.height(share: nil, rows: 900) == 100)
        #expect(short.height(share: nil, rows: 40) == 40)
    }

    @Test func setItStaysWhereItWasPutWhateverTheRows() {
        // A short list has room under it, and more rows than fit scroll.
        #expect(split.height(share: 0.5, rows: 60) == 300)
        #expect(split.height(share: 0.5, rows: 900) == 300)
        // The default's own value, once it was dragged there, is set like any other: a short
        // list does not hug it.
        #expect(split.height(share: 0.5, rows: 60) != split.height(share: nil, rows: 60))
    }

    @Test func withNoRowsItGoesHoweverItWasSet() {
        #expect(split.height(share: nil, rows: nil) == 0)
        #expect(split.height(share: 0.7, rows: nil) == 0)
        #expect(split.height(share: 0.7, rows: 40) == 420)
    }

    @Test func aSetShareKeepsTheProportionAsTheRoomChanges() {
        let height = split.clamped(300 + 60)
        let share = split.share(of: height)
        #expect(abs(split.height(share: share, rows: 40) - 360) < 0.001)
        let wider = SidebarSplit(room: 1000, topMinimum: 80, bottomMinimum: 130)
        #expect(abs(wider.height(share: share, rows: 40) - 600) < 0.001)
    }

    @Test func theMinimumsHold() {
        #expect(split.clamped(0) == 80)
        #expect(split.clamped(-500) == 80)
        #expect(split.clamped(80) == 80)
        #expect(split.clamped(470) == 470)
        #expect(split.clamped(471) == 470)
        #expect(split.clamped(5000) == 470)
    }

    @Test func onAShortWindowTheBottomsMinimumWins() {
        // Not room for both: the space below has its own, and the top what is left.
        let short = SidebarSplit(room: 170, topMinimum: 80, bottomMinimum: 130)
        #expect(short.clamped(0) == 40)
        #expect(short.clamped(160) == 40)
        #expect(short.height(share: 0.9, rows: 40) == 40)
        // Not even that: none for the top, never less than none.
        let shorter = SidebarSplit(room: 100, topMinimum: 80, bottomMinimum: 130)
        #expect(shorter.clamped(50) == 0)
        #expect(shorter.height(share: 0.5, rows: 40) == 0)
    }

    @Test func aBadSavedShareClamps() {
        #expect(split.height(share: -3, rows: 40) == 80)
        #expect(split.height(share: 0, rows: 40) == 80)
        #expect(split.height(share: 40, rows: 40) == 470)
        #expect(split.height(share: .infinity, rows: 40) == 470)
        #expect(split.height(share: -.infinity, rows: 40) == 80)
        // Not a number says nothing of where it was put: as if it was never set.
        #expect(split.height(share: .nan, rows: 40) == 40)
        // No room at all: multiplying by it must not make a number that is not one.
        let none = SidebarSplit(room: 0, topMinimum: 80, bottomMinimum: 130)
        #expect(none.height(share: .infinity, rows: 40) == 0)
    }

    @Test func aDragGoesFromWhereTheDividerReallyIs() {
        // Hugging two rows 120 high, not set: up moves it at once, from there, and not after
        // some way from half the room.
        #expect(split.clamped(120 - 10) == 110)
        // And down too, leaving space under the rows once let go.
        let share = split.share(of: split.clamped(120 + 100))
        #expect(abs(split.height(share: share, rows: 120) - 220) < 0.001)
        // A drag past either end goes no further, and comes back at once.
        #expect(split.clamped(120 - 500) == 80)
        #expect(split.clamped(120 + 5000) == 470)
        #expect(split.clamped(120 + 10) == 130)
    }

    @Test func theShareKeptIsWithinTheMinimums() {
        #expect(split.share(of: 300) == 0.5)
        #expect(split.share(of: 5000) == Double(CGFloat(470) / 600))
        #expect(split.share(of: 0) == Double(CGFloat(80) / 600))
        // No room: nothing to keep a share of, so what was kept stays.
        #expect(SidebarSplit(room: 0, topMinimum: 80, bottomMinimum: 130).share(of: 300) == nil)
    }
}
