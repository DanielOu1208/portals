import Foundation

/// An animated avatar's own clock: seconds since its time 0, read off the system's uptime
/// (`ProcessInfo.systemUptime`), which only goes forward. The time of day can go back (the
/// clock set by hand, or put right by the network): an avatar timed by it, set back an hour
/// while the app was away, found everything it had started an hour in its future, took
/// itself for busy until then and drew 30 frames a second, at the welcome too, where it
/// only blinks.
///
/// While paused (the app in the background, no window of it seen, the avatar out of sight)
/// its time stands still, and it goes on from there.
public struct AvatarClock: Sendable, Equatable {
    /// The avatar's time at its first reading: where on its clock it starts.
    public let start: Double
    /// The uptime of its time 0; nil before its first reading.
    private var origin: TimeInterval?
    /// The uptime it paused at, while it is paused.
    private var pausedAt: TimeInterval?

    public init(start: Double = 0) {
        self.start = start
    }

    /// It has been read once: its time 0 is set.
    public var hasStarted: Bool { origin != nil }

    public var isPaused: Bool { pausedAt != nil }

    /// Its time at `uptime`; while paused, the time it paused at, so that what is drawn
    /// meanwhile (a change of mood) is not ahead of where it goes on from. The first
    /// reading is `start`.
    public mutating func time(at uptime: TimeInterval) -> Double {
        let sampled = sampled(uptime)
        if origin == nil { origin = sampled - start }
        return sampled - (origin ?? sampled)
    }

    /// Paused at `uptime`; one already paused stays paused from when it was.
    public mutating func pause(at uptime: TimeInterval) {
        if pausedAt == nil { pausedAt = uptime }
    }

    /// Goes on at `uptime`, from the time it paused at.
    public mutating func resume(at uptime: TimeInterval) {
        guard let pausedAt else { return }
        self.pausedAt = nil
        origin = origin.map { $0 + max(uptime - pausedAt, 0) }
    }

    /// From `uptime` on, its time reads `time`: the clock moved back (`AgentAvatarDirector`'s
    /// re-anchoring), or on.
    public mutating func set(_ time: Double, at uptime: TimeInterval) {
        origin = sampled(uptime) - time
    }

    private func sampled(_ uptime: TimeInterval) -> TimeInterval {
        pausedAt.map { min($0, uptime) } ?? uptime
    }

    /// The date, by the time of day, for the frame after a timeline's entry for `scheduled`.
    ///
    /// The entry is drawn about now, which is `now` by the time of day and `time` on the
    /// avatar's clock, so its time there is `time` moved by how far `scheduled` is from
    /// `now`; `next` gives the next frame's time from it. A `scheduled` further than `reach`
    /// from `now` was made before the time of day jumped: that entry is taken as now. The
    /// dates go forward, at least `minimumStep` after `scheduled` (a date that rounds back to
    /// it would be asked for for ever), so after the time of day went back the timeline waits
    /// for its last date or a restart (`AgentAvatarView` starts it again then), drawing
    /// nothing meanwhile.
    public static func date(after scheduled: Date, now: Date, time: Double, reach: TimeInterval,
                            minimumStep: TimeInterval = AvatarCadence.minimumStep,
                            next: (Double) -> Double) -> Date
    {
        let lead = scheduled.timeIntervalSince(now)
        let jumped = abs(lead) > reach
        let entry = jumped ? time : time + lead
        let base = jumped ? now : scheduled
        let due = base.addingTimeInterval(next(entry) - entry)
        return max(due, scheduled.addingTimeInterval(minimumStep))
    }
}

/// When an animated avatar draws, on its own clock (`AvatarClock`): what it plays and when
/// that began, the last change seen, and from those whether it is at rest, which spaces its
/// frames out to the blinks (`AvatarCadence`). `AgentAvatarDirector` plays the moods.
public struct AvatarPacing: Sendable, Equatable {
    public var clock: AvatarClock
    public let cadence: AvatarCadence
    /// When the mood playing began, and how long its intro plays, on the avatar's clock.
    public var moodStart = 0.0
    public var moodLength = 0.0
    /// The mood plays in a loop: it never rests.
    public var loops = false
    /// The last time a change that shows began (a state, an expression, a look).
    public var lastChange = -10.0

    /// Longer than any glide a change starts (a state's morph, 0.5 s at most, and the
    /// blink that comes with it).
    public static let settle = 1.0

    public init(clock: AvatarClock, cadence: AvatarCadence = AvatarCadence()) {
        self.clock = clock
        self.cadence = cadence
    }

    /// A mood begins at `time`: its intro plays for `length`, then it holds or loops.
    public mutating func began(length: Double, loops: Bool, at time: Double) {
        moodStart = time
        moodLength = length
        self.loops = loops
    }

    /// Nothing moves but the blinks at `time`: the mood does not loop and has played out,
    /// whatever changed last has glided home, and the body holds a `stillPose`.
    public func isAtRest(at time: Double, stillPose: Bool) -> Bool {
        stillPose && !loops && time - (moodStart + moodLength) > Self.settle && time - lastChange > Self.settle
    }

    /// The date of the frame after a timeline's entry for `scheduled`, asked `now` by the
    /// time of day, at `uptime` (`AvatarClock.date(after:now:time:reach:next:)`).
    public mutating func nextDate(after scheduled: Date, now: Date, uptime: TimeInterval, stillPose: Bool,
                                  blinks: [Double], blinkLength: Double) -> Date
    {
        let time = clock.time(at: uptime)
        // An entry is asked for as the one before it is drawn, at most a rest's gap ahead.
        return AvatarClock.date(after: scheduled, now: now, time: time, reach: cadence.rest + 1) { entry in
            cadence.next(after: entry, atRest: isAtRest(at: entry, stillPose: stillPose), blinks: blinks, blinkLength: blinkLength)
        }
    }
}
