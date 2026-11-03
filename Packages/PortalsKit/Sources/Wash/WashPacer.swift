/// When a wash draws: from its display link while it moves and can be seen, once for each
/// new state while it holds still, and not at all while it cannot be seen (the app in the
/// background, its windows covered), after which it draws again.
public struct WashPacer<State: Equatable>: Sendable where State: Sendable {
    public enum Step: Equatable, Sendable {
        /// Nothing to draw: the display link paused, the picture drawn again on return.
        case pause
        /// Frames from the display link.
        case run
        /// The display link paused; this state drawn once, if it has not been.
        case drawOnce
    }

    private var drawn: (state: State, time: Double)?

    public init() {}

    /// What to do for a new state.
    public mutating func step(isMoving: Bool, isSeen: Bool) -> Step {
        guard isSeen else {
            drawn = nil
            return .pause
        }
        return isMoving ? .run : .drawOnce
    }

    /// Whether to draw `state` at `time`: not when the picture on show is that already.
    public mutating func shouldDraw(_ state: State, at time: Double, isSeen: Bool) -> Bool {
        guard isSeen else { return false }
        if let drawn, drawn.state == state, drawn.time == time { return false }
        drawn = (state, time)
        return true
    }

    /// The picture could not be drawn after all: draw it at the next chance.
    public mutating func forget() {
        drawn = nil
    }
}
