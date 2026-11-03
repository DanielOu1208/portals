import Foundation

/// When a thread that opens may be shown: once it sits at the end of its chat with the
/// height it had the frame before, or after `limit` whatever happens.
///
/// A long thread's first frames are placed by the chat's guess at the height of turns
/// not laid out yet, short of the end; moving it there was seen as a little scroll as
/// the thread opened. The app keeps the chat out of sight meanwhile (`ChatScreen`),
/// and asks this after each frame. The limit keeps a thread from ever being blank for
/// long.
public struct EndSettling: Sendable {
    /// The longest a thread is kept out of sight.
    public static let limit: Duration = .milliseconds(400)
    /// Frames in a row at the end with the height of the frame before, before it is
    /// shown: one, as the turns near the end are laid out for real in the frame after the
    /// chat is moved there, and a height that changes is seen then.
    public static let steadyFrames = 1

    private let started: ContinuousClock.Instant
    private var steady = 0
    private var height: Double?

    public init(started: ContinuousClock.Instant = .now) {
        self.started = started
    }

    /// Whether a chat this far from its end (in points; 0 or less is at the end of one
    /// shorter than its screen) has to be moved there.
    public static func needsMove(distance: Double) -> Bool {
        abs(distance) >= 1
    }

    /// One frame of the chat: how far from its end and how tall, and whether all of it
    /// fits on the screen. True once it is to be shown: at once for a chat that fits, as
    /// all of it is laid out for real and there is no end to find.
    public mutating func frame(distance: Double, height: Double, fits: Bool = false, at now: ContinuousClock.Instant = .now) -> Bool {
        if fits, height > 0 { return true }
        // Nothing laid out yet (no height) is not a chat at its end, however long it lasts.
        steady = !Self.needsMove(distance: distance) && height > 0 && height == self.height ? steady + 1 : 0
        self.height = height
        return steady >= Self.steadyFrames || now - started >= Self.limit
    }
}
