import Foundation
import Testing
@testable import AgentCore

@Suite struct RowNearnessTests {
    private let start = ContinuousClock.now

    @Test func aRowToldNearIsBuiltAndLetGoOfWhenToldItIsNotLater() {
        var row = RowNearness()
        #expect(!row.isBuilt())
        row.told(near: true, at: start)
        #expect(row.isBuilt())
        let taken = row.told(near: false, at: start + .seconds(2))
        #expect(taken)
        #expect(!row.isNear)
        #expect(!row.holdsDeparture)
        #expect(!row.isBuilt())
    }

    /// Dana's gap (2026-10-30): near at the edge of its reach, then "not near" 17 ms later
    /// as the turn's first measurement, 50 points under its estimate, went through; its box
    /// was in reach again once the anchor had moved the chat.
    @Test func notNearAtOnceAfterNearIsHeldAndTheRowStaysNearWhileItsBoxIsInReach() {
        var row = RowNearness()
        row.told(near: true, at: start)
        let taken = row.told(near: false, at: start + .milliseconds(17))
        #expect(!taken)
        #expect(row.isNear)
        #expect(row.holdsDeparture)
        #expect(row.departureCheckedAt == start + RowNearness.settling)
        // Not before the settling time is over.
        let early = row.reconcile(boxInReach: false, at: start + .milliseconds(60))
        #expect(!early)
        #expect(row.isNear)
        let settled = row.reconcile(boxInReach: true, at: start + .milliseconds(150))
        #expect(settled)
        #expect(row.isNear)
        #expect(!row.holdsDeparture)
        #expect(row.isBuilt())
    }

    /// Codex's review of the fix: a row that really left within the settling time (a long
    /// animated scroll past it, or a few points back across the edge of its reach) is told
    /// "not near" once and never again; it is let go of once its box is seen out of reach.
    @Test func aRealDepartureWithinTheSettlingTimeIsLetGoOfWithNoFurtherCallback() {
        var row = RowNearness()
        row.told(near: true, at: start)
        row.told(near: false, at: start + .milliseconds(17))
        #expect(row.isNear)
        // No more from the scroll view: the row stays outside past the deadline.
        let settled = row.reconcile(boxInReach: false, at: start + .milliseconds(150))
        #expect(settled)
        #expect(!row.isNear)
        #expect(!row.holdsDeparture)
        #expect(!row.isBuilt())
    }

    @Test func aRowWhoseBoxIsNotKnownAtTheDeadlineStaysNear() {
        var row = RowNearness()
        row.told(near: true, at: start)
        row.told(near: false, at: start + .milliseconds(30))
        row.reconcile(boxInReach: nil, at: start + .milliseconds(150))
        #expect(row.isNear)
        #expect(!row.holdsDeparture)
    }

    @Test func nearAgainOrNotNearLaterTakesTheHeldDeparturesPlace() {
        var row = RowNearness()
        row.told(near: true, at: start)
        row.told(near: false, at: start + .milliseconds(20))
        row.told(near: true, at: start + .milliseconds(40))
        #expect(!row.holdsDeparture)
        // Counted from the last "near".
        let held = row.told(near: false, at: start + .milliseconds(90))
        #expect(!held)
        #expect(row.departureCheckedAt == start + .milliseconds(40) + RowNearness.settling)
        let taken = row.told(near: false, at: start + .milliseconds(40) + RowNearness.settling)
        #expect(taken)
        #expect(!row.isNear)
        #expect(!row.holdsDeparture)
    }

    @Test func withoutSettlingNotNearIsTakenAtOnce() {
        var row = RowNearness()
        row.told(near: true, at: start)
        let taken = row.told(near: false, at: start + .milliseconds(17), settles: false)
        #expect(taken)
        #expect(!row.isNear)
        #expect(!row.holdsDeparture)
    }

    @Test func aRowOnTheScreenIsBuiltWhateverItsNearTrackerSays() {
        var row = RowNearness()
        row.isOnScreen = true
        #expect(row.isBuilt())
        #expect(!row.isBuilt(onScreenCounts: false))
        row.isOnScreen = false
        #expect(!row.isBuilt())
        #expect(row.isBuilt(kept: true))
    }
}
