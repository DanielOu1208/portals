import Foundation

/// When an animated avatar draws its next frame.
///
/// At its full rate while anything in it moves: a blink, a change of mood, gaze or
/// shape gliding to its new value, a mood that plays in a loop (thinking, talking). At
/// rest nothing moves between blinks (the avatar holds still), so it draws every frame
/// of each blink and, between them, nothing new: the next frame is the next blink's
/// first. Drawing at the full rate kept the window's whole picture redrawn 30 times a
/// second for as long as an avatar was on screen, which on the Mac cost about 7% of a
/// core and some 115 MB of graphics memory while nothing at all was going on
/// (docs/perf-app.md); a few frames a second between blinks, for a drift the avatar no
/// longer has, still cost about 4.8%.
///
/// Times are on the avatar's own clock, in seconds.
public struct AvatarCadence: Equatable, Sendable {
    /// Between frames while something moves.
    public var busy: Double
    /// The longest wait at rest for the next blink: a frame comes at least this often,
    /// drawing the same picture, in case no blink is due.
    public var rest: Double

    /// Less than a frame: a time this close to a blink is at it.
    static let slack = 0.001
    /// The least a next frame is ahead of the last.
    public static let minimumStep = 0.005

    public init(busy: Double = 1.0 / 30, rest: Double = 3) {
        self.busy = busy
        self.rest = rest
    }

    /// The time of the frame after the one at `now`.
    ///
    /// - Parameters:
    ///   - atRest: nothing but the blinks moves (no glide or loop under way).
    ///   - blinks: when each blink starts, in order.
    ///   - blinkLength: how long a blink takes.
    public func next(after now: Double, atRest: Bool, blinks: [Double], blinkLength: Double) -> Double {
        guard atRest else { return now + busy }
        // The first blink that has not ended yet.
        var low = 0
        var high = blinks.count
        while low < high {
            let middle = (low + high) / 2
            if blinks[middle] + blinkLength <= now { low = middle + 1 } else { high = middle }
        }
        let quiet = now + rest
        guard low < blinks.count else { return quiet }
        let blink = blinks[low]
        // Under way: every frame of it. A blink drawn from its start comes back here a
        // hair before it, as the clock's dates round.
        if blink <= now + Self.slack { return now + busy }
        // Starting before the next quiet frame: its first frame on time.
        return min(blink, quiet)
    }
}
