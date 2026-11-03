/// The wash's time: the seconds it has moved for, which stop while it is stopped. Read at
/// each frame while it moves; a reading more than a quarter of a second after the one
/// before (the wash was stopped: the app in the background, its windows covered, or
/// nothing at work) moves it on by one frame only, so that it goes on from where it
/// stopped rather than jumping to where the wall clock would have taken it.
public struct WashClock: Sendable {
    /// The longest step between two readings taken as time that passed.
    public static let longestStep = 0.25
    /// The step taken for a longer gap: a frame at 30 a second.
    public static let resumeStep = 1.0 / 30

    public private(set) var time: Double
    private var lastReading: Double?

    public init(time: Double) {
        self.time = time
    }

    /// The time for a frame drawn at `now` (seconds on any steady clock).
    public mutating func reading(at now: Double) -> Double {
        if let lastReading {
            let step = now - lastReading
            time += step > Self.longestStep ? Self.resumeStep : max(0, step)
        }
        lastReading = now
        return time
    }
}
