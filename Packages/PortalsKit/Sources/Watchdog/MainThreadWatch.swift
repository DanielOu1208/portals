/// What the watchdog decides from its looks at the main thread, without the clocks and
/// threads it takes them with: the samples come in, and the busy stretches and hangs come
/// out. Times are seconds on the uptime clock, which stops while the Mac or phone sleeps.
public struct MainThreadWatch: Sendable {
    public struct Thresholds: Sendable, Equatable {
        /// A stretch is busy when the main thread used at least this share of a core...
        public var busyShare: Double
        /// ...over at least this long.
        public var busyFor: Double
        /// A turn of the main thread's run loop at least this long is a hang.
        public var hangFor: Double
        /// A look this much later than the one before it means the process was stopped (a
        /// phone app in the background, a Mac app napping, a debugger): what happened
        /// meanwhile is not known, and nothing is made of it.
        public var stoppedAfter: Double
        /// A busy stretch still going is told again at this length, and at each double of it.
        public var stillBusyFirst: Double

        public init(busyShare: Double = 0.8, busyFor: Double = 10, hangFor: Double = 2,
                    stoppedAfter: Double = 5, stillBusyFirst: Double = 60) {
            self.busyShare = busyShare
            self.busyFor = busyFor
            self.hangFor = hangFor
            self.stoppedAfter = stoppedAfter
            self.stillBusyFirst = stillBusyFirst
        }
    }

    /// The main thread's run loop as the watchdog's observer left it: when it last began
    /// something, whether it is asleep, and the last hang it saw end.
    public struct Loop: Sendable, Equatable {
        /// When the run loop last woke, or began a turn or a part of one.
        public var lastMark: Double
        /// Whether it is waiting for something to do.
        public var asleep: Bool
        /// The last stretch of at least `hangFor` between two of its marks, once over.
        public var lastHang: (start: Double, end: Double)?

        public init(lastMark: Double, asleep: Bool, lastHang: (start: Double, end: Double)? = nil) {
            self.lastMark = lastMark
            self.asleep = asleep
            self.lastHang = lastHang
        }

        public static func == (a: Loop, b: Loop) -> Bool {
            a.lastMark == b.lastMark && a.asleep == b.asleep
                && a.lastHang?.start == b.lastHang?.start && a.lastHang?.end == b.lastHang?.end
        }
    }

    /// One look: the time, the main thread's CPU time so far, and its run loop.
    public struct Sample: Sendable, Equatable {
        public var time: Double
        public var cpu: Double
        public var loop: Loop

        public init(time: Double, cpu: Double, loop: Loop) {
            self.time = time
            self.cpu = cpu
            self.loop = loop
        }
    }

    public enum Phase: String, Sendable, Equatable {
        case began, continues, ended
    }

    public enum Event: Sendable, Equatable {
        /// The main thread was busy from `start` for `seconds`, using `share` of a core.
        case busy(Phase, start: Double, seconds: Double, share: Double)
        /// The run loop has been on one turn since `start` (`began`, a look while it lasts),
        /// or was, for `seconds` (`ended`).
        case hang(Phase, start: Double, seconds: Double)

        /// Whether a look at the main thread's stack belongs with it: while it is happening.
        public var wantsStack: Bool {
            switch self {
            case .busy(let phase, _, _, _), .hang(let phase, _, _): phase != .ended
            }
        }
    }

    public let thresholds: Thresholds

    /// The last look.
    private var last: Sample?
    /// The latest looks covering at least `busyFor`: time and CPU time between each and
    /// the one before.
    private var window: [(seconds: Double, cpu: Double)] = []
    private var windowSeconds = 0.0
    private var windowCPU = 0.0
    private var busy: Busy?
    /// The run loop mark a hang was told for while it lasted, so it is told once.
    private var hangToldAt: Double?
    /// The end of the last finished hang told, or skipped.
    private var hangSeenEnd: Double?
    /// The last time the process was stopped: somewhere between these two looks.
    private var lastStop: (from: Double, to: Double)?

    /// A busy stretch under way.
    private struct Busy {
        var start: Double
        /// Up to the end of the last look that was busy on its own: what is told at the end.
        var seconds: Double
        var cpu: Double
        /// Everything since the start, the looks since the last busy one too.
        var allSeconds: Double
        var allCPU: Double
        var tellAgainAt: Double
    }

    public init(thresholds: Thresholds = Thresholds()) {
        self.thresholds = thresholds
    }

    /// Takes a look and says what it shows.
    public mutating func add(_ sample: Sample) -> [Event] {
        defer { last = sample }
        guard let last else {
            // The first look: a hang already under way can be told; the busy share needs two.
            return hangEvents(sample)
        }
        let seconds = sample.time - last.time
        guard seconds > 0 else { return [] }
        var events: [Event] = []
        if seconds >= thresholds.stoppedAfter {
            // Stopped in between: what was going on before is told as far as it was seen.
            lastStop = (last.time, sample.time)
            events += endBusy()
            clearWindow()
        } else {
            events += busyEvents(seconds: seconds, cpu: max(0, sample.cpu - last.cpu), at: sample.time)
        }
        events += hangEvents(sample)
        return events
    }

    /// The watchdog looks again at `time` after it stopped looking (the app away from the
    /// front, `Watchdog.pause`): nothing is known of what happened meanwhile, as for a
    /// process stopped. A busy stretch is told as far as it was seen, the next look takes
    /// the CPU time from scratch, and a run loop turn across the pause is no hang.
    /// Resumed again with no look since the last resume, the stop runs on from where it
    /// began, through this one.
    public mutating func resumed(at time: Double) -> [Event] {
        if let last {
            lastStop = (last.time, time)
        } else {
            lastStop = (lastStop?.from ?? time, time)
        }
        last = nil
        clearWindow()
        return endBusy()
    }

    // MARK: Busy

    private mutating func busyEvents(seconds: Double, cpu: Double, at time: Double) -> [Event] {
        window.append((seconds, cpu))
        windowSeconds += seconds
        windowCPU += cpu
        // Keep the newest looks that cover `busyFor`, and no more.
        while let first = window.first, windowSeconds - first.seconds >= thresholds.busyFor {
            window.removeFirst()
            windowSeconds -= first.seconds
            windowCPU -= first.cpu
        }
        let windowIsBusy = windowSeconds >= thresholds.busyFor && windowCPU >= thresholds.busyShare * windowSeconds

        guard var busy else {
            guard windowIsBusy else { return [] }
            // It began with the first look in the window that was busy on its own.
            var seconds = windowSeconds
            var cpu = windowCPU
            for look in window {
                guard look.cpu < thresholds.busyShare * look.seconds else { break }
                seconds -= look.seconds
                cpu -= look.cpu
            }
            let start = time - seconds
            self.busy = Busy(start: start, seconds: seconds, cpu: cpu, allSeconds: seconds, allCPU: cpu,
                             tellAgainAt: max(thresholds.stillBusyFirst, seconds * 2))
            return [.busy(.began, start: start, seconds: seconds, share: cpu / seconds)]
        }
        busy.allSeconds += seconds
        busy.allCPU += cpu
        if cpu >= thresholds.busyShare * seconds {
            busy.seconds = busy.allSeconds
            busy.cpu = busy.allCPU
        }
        guard windowIsBusy else {
            self.busy = busy
            return endBusy()
        }
        var events: [Event] = []
        if busy.allSeconds >= busy.tellAgainAt {
            events.append(.busy(.continues, start: busy.start, seconds: busy.allSeconds, share: busy.allCPU / busy.allSeconds))
            busy.tellAgainAt *= 2
        }
        self.busy = busy
        return events
    }

    private mutating func endBusy() -> [Event] {
        guard let busy else { return [] }
        self.busy = nil
        return [.busy(.ended, start: busy.start, seconds: busy.seconds, share: busy.cpu / busy.seconds)]
    }

    private mutating func clearWindow() {
        window.removeAll()
        windowSeconds = 0
        windowCPU = 0
    }

    // MARK: Hangs

    /// A turn that seems to have lasted across a stop of the whole process did not: the
    /// main thread was stopped with the rest, and nothing is made of it.
    private mutating func hangEvents(_ sample: Sample) -> [Event] {
        var events: [Event] = []
        let loop = sample.loop
        if let hang = loop.lastHang, hang.end != hangSeenEnd {
            hangSeenEnd = hang.end
            if !acrossStop(from: hang.start, to: hang.end) {
                events.append(.hang(.ended, start: hang.start, seconds: hang.end - hang.start))
            }
        }
        if acrossStop(from: loop.lastMark, to: sample.time) {
            hangToldAt = loop.lastMark
        } else if !loop.asleep, sample.time - loop.lastMark >= thresholds.hangFor, hangToldAt != loop.lastMark {
            hangToldAt = loop.lastMark
            events.append(.hang(.began, start: loop.lastMark, seconds: sample.time - loop.lastMark))
        }
        return events
    }

    private func acrossStop(from start: Double, to end: Double) -> Bool {
        guard let lastStop else { return false }
        return start < lastStop.to && end > lastStop.from
    }
}
