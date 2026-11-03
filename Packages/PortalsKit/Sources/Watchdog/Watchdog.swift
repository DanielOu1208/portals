import CoreFoundation
import Darwin
import Foundation
import Synchronization
import os

/// Notices when the main thread stays busy for a long stretch, or its run loop is stuck on
/// one turn, and writes it down: a line in the system log (category `watchdog`) and an
/// entry at the end of `watchdog.jsonl` in its folder, with the main thread's stack while
/// it happens.
///
/// It costs the main thread almost nothing and never makes it wait: an observer on its run
/// loop notes the time at each turn in atomics, and the rest happens on a thread of the
/// watchdog's own, which looks once a second at the main thread's CPU time and at what the
/// observer noted (`MainThreadWatch` decides what that shows). Only when something is
/// found does it stop the main thread, for well under a millisecond, to copy its stack.
public final class Watchdog: @unchecked Sendable {
    /// The one started for the main thread, if any.
    public static var shared: Watchdog? { running.withLock { $0 } }
    private static let running = Mutex<Watchdog?>(nil)

    public static let logger = Logger(subsystem: "com.danielou.portals", category: "watchdog")
    /// The file's name in the watchdog's folder.
    public static let fileName = "watchdog.jsonl"

    public let folder: URL
    public let thresholds: MainThreadWatch.Thresholds
    /// What is said of the app in each entry: its version and the system's.
    private let about: String

    private let queue = DispatchQueue(label: "com.danielou.portals.watchdog", qos: .utility)
    private let marks: LoopMarks
    private let thread: ThreadProbe
    private let runLoop: CFRunLoop
    private let interval: Double
    private let log: CappedLog
    private var observers: [CFRunLoopObserver] = []
    private var timer: DispatchSourceTimer?

    // On `queue` only.
    private var watch: MainThreadWatch
    private var screen = ""
    private var ticks = 0
    private var tickNanos: UInt64 = 0
    private var written = 0
    /// Looks are paused (`pause`); the timer is suspended.
    private var isPaused = false

    /// Starts watching the main thread, writing into `folder`, once. Call it on the main
    /// thread, as early as the app can.
    @discardableResult
    public static func start(folder: URL, about: String) -> Watchdog {
        dispatchPrecondition(condition: .onQueue(.main))
        return running.withLock { current in
            if let current { return current }
            let watchdog = Watchdog(thread: .current(), runLoop: CFRunLoopGetMain(), folder: folder, about: about)
            watchdog.start()
            current = watchdog
            return watchdog
        }
    }

    /// A watchdog for `thread`, whose run loop is `runLoop`, looking every `interval`
    /// seconds. Not yet started.
    public init(thread: ThreadProbe, runLoop: CFRunLoop, folder: URL, about: String,
                thresholds: MainThreadWatch.Thresholds = .init(), interval: Double = 1, cap: Int = 512 * 1024) {
        self.thread = thread
        self.runLoop = runLoop
        self.folder = folder
        self.about = about
        self.thresholds = thresholds
        self.interval = interval
        self.watch = MainThreadWatch(thresholds: thresholds)
        // Started on the thread watched, it is busy starting it; from another, it may be
        // asleep, which its first turn will say.
        self.marks = LoopMarks(hangFor: thresholds.hangFor, asleep: CFRunLoopGetCurrent() !== runLoop)
        self.log = CappedLog(url: folder.appendingPathComponent(Self.fileName), cap: cap)
    }

    /// Puts the observers on the run loop and starts looking.
    public func start() {
        let marks = marks
        // First on waking and at each part of a turn; last before sleeping, after Core
        // Animation's commit and SwiftUI's updates, which happen there too.
        let early = CFRunLoopObserverCreateWithHandler(
            kCFAllocatorDefault,
            CFRunLoopActivity([.entry, .beforeTimers, .beforeSources, .afterWaiting]).rawValue,
            true, CFIndex.min
        ) { _, activity in
            marks.note(woke: activity == .afterWaiting, asleep: false)
        }
        let late = CFRunLoopObserverCreateWithHandler(
            kCFAllocatorDefault, CFRunLoopActivity([.beforeWaiting, .exit]).rawValue, true, CFIndex.max
        ) { _, activity in
            marks.note(woke: false, asleep: activity == .beforeWaiting)
        }
        for observer in [early, late].compactMap({ $0 }) {
            CFRunLoopAddObserver(runLoop, observer, .commonModes)
            observers.append(observer)
        }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(Int(interval * 250)))
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
    }

    /// Stops looking for now: the app is away from the front (`AppWatchdog`), where a
    /// look a second is a wake-up a second for nothing anyone waits on. The observers stay:
    /// they cost nothing while the main thread sleeps. Paused twice, it stays paused.
    public func pause() {
        queue.async { [self] in
            guard let timer, !isPaused else { return }
            timer.suspend()
            isPaused = true
        }
    }

    /// Looks again, once a second from now, at what happens from now: the time away is
    /// not taken for a busy stretch or a hang (`MainThreadWatch.resumed`).
    public func resume() {
        queue.async { [self] in
            guard let timer, isPaused else { return }
            isPaused = false
            let now = LoopMarks.seconds(clock_gettime_nsec_np(CLOCK_UPTIME_RAW))
            let wall = Date()
            for event in watch.resumed(at: now) {
                write(event, at: (now, wall), frames: [])
            }
            timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(Int(interval * 250)))
            timer.resume()
        }
    }

    /// Stops looking and takes the observers off.
    public func stop() {
        queue.sync {
            // A suspended source is to be resumed before it goes.
            if isPaused { timer?.resume() }
            isPaused = false
        }
        timer?.cancel()
        timer = nil
        for observer in observers {
            CFRunLoopRemoveObserver(runLoop, observer, .commonModes)
        }
        observers = []
    }

    /// What is on screen, for the entries written from now on. Never waits.
    public func note(screen: String) {
        queue.async { self.screen = screen }
    }

    /// What the watchdog has cost so far: its looks, and the CPU time they took on its thread.
    public func cost() -> (looks: Int, seconds: Double, entries: Int) {
        queue.sync { (ticks, Double(tickNanos) / 1e9, written) }
    }

    private func tick() {
        let began = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        defer {
            ticks += 1
            tickNanos += clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) &- began
        }
        guard let cpu = thread.cpuSeconds() else { return }
        let now = LoopMarks.seconds(clock_gettime_nsec_np(CLOCK_UPTIME_RAW))
        // The time of day of the look, before naming the stack's frames, which the first
        // time can take a second.
        let wall = Date()
        let events = watch.add(MainThreadWatch.Sample(time: now, cpu: cpu, loop: marks.loop()))
        guard !events.isEmpty else { return }
        // One look at the stack serves every event of this look.
        let frames = events.contains(where: \.wantsStack) ? StackText.frames(thread.backtrace()) : []
        for event in events {
            write(event, at: (now, wall), frames: event.wantsStack ? frames : [])
        }
    }

    private func write(_ event: MainThreadWatch.Event, at look: (uptime: Double, date: Date), frames: [StackText.Frame]) {
        let entry = Entry(event, at: look, screen: screen, about: about, frames: frames)
        let text = entry.summary
        switch event {
        case .busy(.ended, _, _, _), .hang(.ended, _, _):
            Self.logger.notice("\(text, privacy: .public)")
        default:
            Self.logger.error("\(text, privacy: .public)")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(entry), let line = String(data: data, encoding: .utf8) else { return }
        do {
            try log.append(line)
            written += 1
        } catch {
            Self.logger.error("Could not write \(Self.fileName, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    /// One line of the file.
    struct Entry: Encodable {
        /// `busy` or `hang`.
        var kind: String
        /// `began`, `continues` or `ended`.
        var phase: String
        /// When it started, and how long it has lasted (so far, unless `ended`).
        var start: String
        var seconds: Double
        /// The share of a core the main thread used meanwhile, for `busy`.
        var busy: Double?
        var screen: String
        var app: String
        /// The main thread's stack, innermost first, while it happens; and the UUID of each
        /// image named there, which finds its dSYM.
        var stack: [String]?
        var images: [String: String]?

        /// `look`: when the look that found it was, on the uptime clock and as a date.
        init(_ event: MainThreadWatch.Event, at look: (uptime: Double, date: Date), screen: String, about: String, frames: [StackText.Frame]) {
            let started: Double
            let length: Double
            switch event {
            case let .busy(phase, start, seconds, share):
                (kind, self.phase, started, length, busy) = ("busy", phase.rawValue, start, seconds, (share * 1000).rounded() / 1000)
            case let .hang(phase, start, seconds):
                (kind, self.phase, started, length, busy) = ("hang", phase.rawValue, start, seconds, nil)
            }
            seconds = (length * 100).rounded() / 100
            start = Self.time.format(look.date.addingTimeInterval(started - look.uptime))
            self.screen = screen
            app = about
            if !frames.isEmpty {
                stack = frames.map(\.line)
                images = StackText.uuids(of: frames)
            }
        }

        /// The time of day here, to the millisecond: `2026-10-19T14:03:22.123+0200`.
        private static let time = Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: .current)

        /// The entry in a sentence, for the system log.
        var summary: String {
            var text = kind == "busy"
                ? "Main thread busy (\(phase)): \(Int(((busy ?? 0) * 100).rounded()))% of a core for \(seconds) s since \(start)"
                : "Main thread hang (\(phase)): one run loop turn for \(seconds) s since \(start)"
            if !screen.isEmpty { text += ", on \(screen)" }
            if let stack { text += "; stack: " + stack.prefix(12).joined(separator: " | ") }
            return text
        }
    }
}

/// What the observers on the watched run loop note, in atomics, so the run loop never
/// waits for the watchdog's thread.
final class LoopMarks: Sendable {
    /// Nanoseconds on the uptime clock.
    private let mark: Atomic<UInt64>
    private let asleep: Atomic<Bool>
    private let hangEnd = Atomic<UInt64>(0)
    private let hangLength = Atomic<UInt64>(0)
    private let hangNanos: UInt64

    init(hangFor seconds: Double, asleep: Bool) {
        hangNanos = UInt64(seconds * 1e9)
        mark = Atomic(clock_gettime_nsec_np(CLOCK_UPTIME_RAW))
        self.asleep = Atomic(asleep)
    }

    static func seconds(_ nanos: UInt64) -> Double { Double(nanos) / 1e9 }

    /// On the watched thread, from an observer: the run loop `woke` from sleep, is about to
    /// sleep (`asleep`), or is at another point of a turn.
    func note(woke: Bool, asleep willSleep: Bool) {
        let now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        // Time asleep is not a turn; any other time since the last mark is part of one.
        if !woke, !asleep.load(ordering: .relaxed) {
            let since = mark.load(ordering: .relaxed)
            if now &- since >= hangNanos {
                hangLength.store(now &- since, ordering: .relaxed)
                hangEnd.store(now, ordering: .releasing)
            }
        }
        asleep.store(willSleep, ordering: .relaxed)
        mark.store(now, ordering: .releasing)
    }

    /// On the watchdog's thread.
    func loop() -> MainThreadWatch.Loop {
        let mark = mark.load(ordering: .acquiring)
        let asleep = asleep.load(ordering: .relaxed)
        let end = hangEnd.load(ordering: .acquiring)
        let length = hangLength.load(ordering: .relaxed)
        let hang = end == 0 ? nil : (start: Self.seconds(end &- length), end: Self.seconds(end))
        return MainThreadWatch.Loop(lastMark: Self.seconds(mark), asleep: asleep, lastHang: hang)
    }
}
