import Foundation
import Testing
@testable import AgentCore

@Suite struct GroupSpacingTests {
    /// Three groups of two rows, as Dana's sidebar often has: the room they take
    /// besides the titles' own text.
    private func room(_ spacing: GroupSpacing) -> CGFloat {
        spacing.height(titles: 3, rows: 6, title: spacing.titleTop + spacing.titleBottom + 18, row: 0)
    }

    @Test func beforeIsHowTheyWere() {
        // RowMetrics before 2026-10-19: sectionGap 26 (22 on a Mac), titleGap 4, tallHeight 50 (46), spacing 2.
        #expect(GroupSpacing.touch(.before) == GroupSpacing(titleTop: 26, titleBottom: 4, rowHeight: 50, rowGap: 2))
        #expect(GroupSpacing.mac(.before) == GroupSpacing(titleTop: 22, titleBottom: 4, rowHeight: 46, rowGap: 2))
    }

    @Test(arguments: [false, true]) func theGroupsAreTighterThanBefore(onMac: Bool) {
        let spacing = onMac ? GroupSpacing.mac : GroupSpacing.touch
        let before = spacing(.before), chosen = spacing(nil)
        #expect(chosen.titleTop < before.titleTop)
        #expect(chosen.titleBottom < before.titleBottom)
        #expect(chosen.rowHeight < before.rowHeight)
        #expect(room(chosen) <= room(before) * 0.9)
    }

    @Test(arguments: [false, true]) func theVariantsGoFromTighterToHowTheyWere(onMac: Bool) {
        let spacing = onMac ? GroupSpacing.mac : GroupSpacing.touch
        let order = [spacing(.tighter), spacing(nil), spacing(.looser), spacing(.before)].map(room)
        #expect(order == order.sorted())
        #expect(Set(order).count == order.count)
    }

    @Test func everyRowStaysAFingerHighOrRoomyEnoughForAPointer() {
        for variant in [nil] + GroupSpacing.Variant.allCases.map(Optional.some) {
            #expect(GroupSpacing.touch(variant).rowHeight >= 44)
            #expect(GroupSpacing.mac(variant).rowHeight >= 36)
        }
    }

    @Test func theirHeightIsWorkedOutFromOneTitleAndOneRow() {
        let spacing = GroupSpacing.touch()
        // Two titles of 36 points, five rows of 46, six gaps of 2 between the seven.
        let seven: CGFloat = 2 * 36 + 5 * 46 + 6 * 2
        #expect(spacing.height(titles: 2, rows: 5, title: 36, row: 46) == seven)
        // A row not measured yet counts as tall as rows are at least; a taller one (a
        // larger text size) as tall as it is.
        let unmeasured: CGFloat = 36 + 2 * 46 + 2 * 2
        let taller: CGFloat = 36 + 2 * 60 + 2 * 2
        #expect(spacing.height(titles: 1, rows: 2, title: 36, row: 0) == unmeasured)
        #expect(spacing.height(titles: 1, rows: 2, title: 36, row: 60) == taller)
        #expect(spacing.height(titles: 0, rows: 0, title: 36, row: 46) == 0)
    }

    @Test func theSwitchNamesTheVariants() {
        #expect(GroupSpacing.Variant(rawValue: "tighter") == .tighter)
        #expect(GroupSpacing.Variant(rawValue: "looser") == .looser)
        #expect(GroupSpacing.Variant(rawValue: "before") == .before)
        #expect(GroupSpacing.Variant(rawValue: "loose") == nil)
    }
}
