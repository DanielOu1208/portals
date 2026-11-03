import Foundation

/// Whether a row of the transcript is built (`TranscriptTurn`, `TranscriptBlock` in the
/// app), from what the scroll view tells it: whether a box twice the screen's reach around
/// it is in view (near), and whether the row itself is (on the screen).
///
/// Two things the scroll view was seen to get wrong are made up for (2026-10-30:
/// "chat rendering is bugged like theres big gaps sometimes"; found with GapProbe):
/// - A row told "not near" within moments of "near" stays near for now, and the "not near"
///   is held: that is the row's own first measurement seen half done (a row shorter than
///   its estimate, come near from above, is laid out shorter, which takes its box out of
///   reach until the anchor moves the chat by as much in the same update). The scroll view
///   told "not near" for that, and then nothing more as the row crossed the whole screen,
///   its space empty. Once the settling time is over, the held "not near" is checked
///   against where the row's box is then (`reconcile`): a row that really left, which the
///   scroll view will not say again, is let go of (Codex's review: one passed in under a
///   tenth of a second, by a long animated scroll or a few points back and forth across
///   the edge of its reach, stayed built for good).
/// - A row on the screen is built whatever its near tracker says, so that one left that way
///   by some other path is built as it comes into view rather than never.
public struct RowNearness: Equatable, Sendable {
    /// How soon after "near" a "not near" is taken for the row's own measurement. No row
    /// goes in and out of a reach twice the screen's height in a tenth of a second.
    public static let settling: Duration = .milliseconds(100)

    /// Whether the row counts as near the screen.
    public private(set) var isNear = false
    /// Whether the row is on the screen.
    public var isOnScreen = false
    /// When it was last told it is near.
    private var toldNearAt: ContinuousClock.Instant?
    /// When a "not near" told within the settling time is to be checked (`reconcile`):
    /// nil when none is held.
    public private(set) var departureCheckedAt: ContinuousClock.Instant?

    public init() {}

    /// Whether a "not near" is held, to be checked once the settling time is over.
    public var holdsDeparture: Bool { departureCheckedAt != nil }

    /// Whether the row is built: near or on the screen (unless `onScreenCounts` is false,
    /// to compare with before), or `kept` built anyway.
    public func isBuilt(kept: Bool = false, onScreenCounts: Bool = true) -> Bool {
        isNear || (isOnScreen && onScreenCounts) || kept
    }

    /// Takes in what the scroll view told of the row's box at `now`; false when a "not
    /// near" was held as maybe the row's own measurement (never with `settles` false),
    /// to be checked at `departureCheckedAt`.
    @discardableResult
    public mutating func told(near: Bool, at now: ContinuousClock.Instant, settles: Bool = true) -> Bool {
        if near {
            toldNearAt = now
        } else if settles, let toldNearAt, now - toldNearAt < Self.settling {
            departureCheckedAt = toldNearAt + Self.settling
            return false
        }
        departureCheckedAt = nil
        isNear = near
        return true
    }

    /// Settles a held "not near" by where the row's box is now: in reach (`boxInReach`,
    /// any of it in the scroll view's bounds), the row stays near; out of it, it is let go
    /// of; not known, it stays near. Nothing before the settling time is over, or with no
    /// "not near" held. True when it settled one.
    @discardableResult
    public mutating func reconcile(boxInReach: Bool?, at now: ContinuousClock.Instant) -> Bool {
        guard let departureCheckedAt, now >= departureCheckedAt else { return false }
        self.departureCheckedAt = nil
        if boxInReach == false { isNear = false }
        return true
    }
}
