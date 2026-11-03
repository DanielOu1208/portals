import Testing
@testable import Watchdog

@Suite struct MainThreadWatchTests {
    /// Looks once a second from `from`, the main thread using `share` of a core in each,
    /// its run loop asleep between turns.
    struct Feed {
        var watch = MainThreadWatch()
        var time = 100.0
        var cpu = 3.0
        var events: [MainThreadWatch.Event] = []

        mutating func run(seconds: Int, share: Double, every step: Double = 1) {
            for _ in 0..<Int(Double(seconds) / step) {
                look(after: step, share: share)
            }
        }

        mutating func look(after step: Double, share: Double, loop: MainThreadWatch.Loop? = nil) {
            time += step
            cpu += share * step
            events += watch.add(.init(time: time, cpu: cpu, loop: loop ?? .init(lastMark: time - 0.01, asleep: true)))
        }
    }

    /// Looks paused while the app was away (`Watchdog.pause`), for less than a stop's gap:
    /// the CPU the main thread used meanwhile is not taken for one look's, a turn under way
    /// across the pause is no hang, and a busy stretch is told ended as far as it was seen.
    @Test func lookingAgainAfterAPauseStartsFromScratch() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        feed.run(seconds: 12, share: 1)
        #expect(feed.events.map(\.wantsStack) == [true])
        // Paused 3 s: the busy stretch is told over, as far as it was seen.
        let ended = feed.watch.resumed(at: feed.time + 3)
        #expect(ended.count == 1)
        if case let .busy(phase, _, seconds, _) = ended.first {
            #expect(phase == .ended)
            #expect(seconds == 12)
        }
        feed.events = []
        // Two seconds of CPU went meanwhile, and the run loop's last mark is from before
        // the pause, awake (the app inactive in the middle of a turn): neither is told.
        feed.time += 3
        feed.cpu += 2
        feed.look(after: 0.5, share: 0.01, loop: .init(lastMark: feed.time - 3, asleep: false))
        feed.run(seconds: 30, share: 0.01)
        #expect(feed.events.isEmpty, "\(feed.events)")
        // A hang that begins after it is told.
        feed.look(after: 1, share: 0.01, loop: .init(lastMark: feed.time - 1.5, asleep: false))
        feed.look(after: 1, share: 0.01, loop: .init(lastMark: feed.time - 2.5, asleep: false))
        #expect(feed.events.count == 1)
    }

    /// Two pauses one after the other with no look between them (inactive, active,
    /// inactive, active within a second): a turn across the first is no hang either.
    /// The second resume took the first's place, and the run loop's hang that crossed the
    /// first pause was told as a 10 s hang (Codex's review of the battery fixes).
    @Test func twoPausesWithNoLookBetweenThemAreOneStop() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        feed.run(seconds: 10, share: 0.01)
        let last = feed.time
        #expect(feed.watch.resumed(at: last + 10).isEmpty)
        #expect(feed.watch.resumed(at: last + 10.5).isEmpty)
        // The run loop saw one turn from just after the last look to just after the first
        // resume: the main thread stopped with the app, not a hang.
        feed.time = last + 11
        feed.events += feed.watch.add(.init(time: feed.time, cpu: feed.cpu,
                                            loop: .init(lastMark: feed.time - 0.2, asleep: true, lastHang: (last + 0.1, last + 10.1))))
        #expect(feed.events.isEmpty, "\(feed.events)")
        // A turn begun after both, 2.5 s long by the third look, is a hang.
        let mark = last + 11.5
        for _ in 0..<3 {
            feed.look(after: 1, share: 0.01, loop: .init(lastMark: mark, asleep: false))
        }
        #expect(feed.events == [.hang(.began, start: mark, seconds: 2.5)], "\(feed.events)")
    }

    @Test func atRestAndWhileAReplyStreamsNothingIsTold() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        feed.run(seconds: 120, share: 0.01)
        // A reply streaming into the thread on screen: about a fifth of a core, sometimes
        // half for a second.
        for second in 0..<120 {
            feed.look(after: 1, share: second % 7 == 0 ? 0.55 : 0.2)
        }
        #expect(feed.events.isEmpty)
    }

    @Test func eightBusySecondsInTenAreToldOnceWithWhenTheyBegan() throws {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        feed.run(seconds: 5, share: 1.0 / 64)
        let start = feed.time
        feed.run(seconds: 7, share: 1)
        #expect(feed.events.isEmpty)
        feed.run(seconds: 1, share: 1)
        // From the first busy second, not the quiet ones before it in the window.
        #expect(feed.events == [.busy(.began, start: start, seconds: 8, share: 1)])
        feed.run(seconds: 20, share: 0.97)
        #expect(feed.events.count == 1)
    }

    @Test func justUnderTheShareIsNotBusyJustOverIs() {
        var under = Feed()
        under.look(after: 0, share: 0)
        under.run(seconds: 60, share: 0.79)
        #expect(under.events.isEmpty)

        var over = Feed()
        over.look(after: 0, share: 0)
        over.run(seconds: 30, share: 0.81)
        guard case .busy(.began, _, let seconds, let share)? = over.events.first else {
            Issue.record("not told: \(over.events)")
            return
        }
        #expect(seconds == 10)
        #expect(over.events.count == 1)
        #expect(abs(share - 0.81) < 1e-9)
    }

    @Test func sevenBusySecondsInTenAreNotEnough() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        for _ in 0..<6 {
            feed.run(seconds: 7, share: 1)
            feed.run(seconds: 3, share: 0)
        }
        #expect(feed.events.isEmpty)
    }

    @Test func aStretchThatGoesOnIsToldAgainAtEachDoubleAndItsEndLeavesOutTheIdleTail() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        let start = feed.time
        feed.run(seconds: 300, share: 1)
        feed.run(seconds: 20, share: 0)
        let phases = feed.events.map { event -> MainThreadWatch.Phase? in
            if case let .busy(phase, _, _, _) = event { phase } else { nil }
        }
        #expect(phases == [.began, .continues, .continues, .continues, .ended])
        let again = feed.events.compactMap { event -> Double? in
            if case let .busy(.continues, _, seconds, _) = event { seconds } else { nil }
        }
        #expect(again == [60, 120, 240])
        guard case let .busy(.ended, from, seconds, share)? = feed.events.last else {
            Issue.record("\(feed.events)")
            return
        }
        #expect(from == start)
        // Up to the last busy second, not the quiet ones that took the window under.
        #expect(seconds == 300)
        #expect(share == 1)
    }

    @Test func busyWithAQuietSecondNowAndThenStaysOneStretch() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        for _ in 0..<10 {
            feed.run(seconds: 9, share: 1)
            feed.run(seconds: 1, share: 0.3)
        }
        feed.run(seconds: 15, share: 0)
        #expect(feed.events.count == 3) // began, continues at 60 s, ended
        guard case let .busy(.ended, _, seconds, share) = feed.events.last else {
            Issue.record("\(feed.events)")
            return
        }
        #expect(seconds == 99)
        #expect(share > 0.9)
    }

    @Test func looksWithUnevenGapsStillAddUp() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        let start = feed.time
        for step in [1.2, 0.9, 1.25, 1.0, 1.1, 0.95, 1.2, 1.0, 1.15] {
            feed.look(after: step, share: 1)
        }
        #expect(feed.events.isEmpty) // 9.75 s
        feed.look(after: 1.2, share: 1)
        guard case let .busy(.began, from, seconds, _)? = feed.events.first else {
            Issue.record("\(feed.events)")
            return
        }
        #expect(abs(from - start) < 1e-9)
        #expect(abs(seconds - 10.95) < 1e-9)
    }

    @Test func aStopOfTheProcessEndsAStretchAndStartsTheCountAgain() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        feed.run(seconds: 12, share: 1)
        #expect(feed.events.count == 1)
        // Suspended in the background for a minute: no CPU time, and nothing known.
        feed.look(after: 60, share: 0)
        guard case let .busy(.ended, _, seconds, _)? = feed.events.last else {
            Issue.record("\(feed.events)")
            return
        }
        #expect(seconds == 12)
        // Busy again after: ten more seconds are needed.
        feed.events = []
        feed.run(seconds: 9, share: 1)
        #expect(feed.events.isEmpty)
        feed.run(seconds: 1, share: 1)
        #expect(feed.events.count == 1)
    }

    // MARK: Hangs

    @Test func aTurnOfTwoSecondsIsToldWhileItLastsAndOnceItIsOver() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        feed.run(seconds: 3, share: 0.01)
        let start = feed.time + 0.5
        feed.look(after: 1, share: 0.5, loop: .init(lastMark: start, asleep: false))
        feed.look(after: 1, share: 1, loop: .init(lastMark: start, asleep: false))
        #expect(feed.events.isEmpty) // 1.5 s so far
        feed.look(after: 1, share: 1, loop: .init(lastMark: start, asleep: false))
        #expect(feed.events == [.hang(.began, start: start, seconds: 2.5)])
        feed.look(after: 1, share: 1, loop: .init(lastMark: start, asleep: false))
        #expect(feed.events.count == 1)
        // Over after 3.9 s: the observer saw it end.
        let end = start + 3.75
        feed.look(after: 1, share: 0.25, loop: .init(lastMark: end + 0.125, asleep: true, lastHang: (start, end)))
        #expect(feed.events.count == 2)
        guard case let .hang(.ended, from, seconds) = feed.events[1] else {
            Issue.record("\(feed.events)")
            return
        }
        #expect(from == start)
        #expect(seconds == 3.75)
        // Seen again in later looks: told once.
        feed.look(after: 1, share: 0.01, loop: .init(lastMark: end + 1, asleep: true, lastHang: (start, end)))
        #expect(feed.events.count == 2)
    }

    @Test func aHangBetweenLooksIsToldWhenOver() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        let start = feed.time + 0.5
        feed.look(after: 1, share: 0.5, loop: .init(lastMark: start, asleep: false))
        feed.look(after: 2, share: 0.75, loop: .init(lastMark: start + 2.25, asleep: true, lastHang: (start, start + 2.25)))
        #expect(feed.events.count == 1)
        guard case .hang(.ended, start, _)? = feed.events.first else {
            Issue.record("\(feed.events)")
            return
        }
    }

    @Test func asleepIsNotAHangHoweverLong() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        let mark = feed.time
        for _ in 0..<30 {
            feed.look(after: 1, share: 0, loop: .init(lastMark: mark, asleep: true))
        }
        #expect(feed.events.isEmpty)
    }

    @Test func aTurnThatSeemsToLastAcrossAStopIsNotAHang() {
        var feed = Feed()
        feed.look(after: 0, share: 0)
        // Stopped mid-turn (the process suspended), the stretch noted when it woke.
        let mark = feed.time - 0.2
        feed.look(after: 40, share: 0, loop: .init(lastMark: mark, asleep: false))
        feed.look(after: 1, share: 0.01, loop: .init(lastMark: feed.time + 0.5, asleep: true, lastHang: (mark, feed.time + 0.5)))
        feed.run(seconds: 5, share: 0.01)
        #expect(feed.events.isEmpty)
        // A real one after it is told.
        let start = feed.time
        feed.look(after: 2.5, share: 1, loop: .init(lastMark: start, asleep: false))
        #expect(feed.events == [.hang(.began, start: start, seconds: 2.5)])
    }

    @Test func aHangAlreadyUnderWayAtTheFirstLookIsTold() {
        var watch = MainThreadWatch()
        let events = watch.add(.init(time: 10, cpu: 2, loop: .init(lastMark: 7, asleep: false)))
        #expect(events == [.hang(.began, start: 7, seconds: 3)])
        #expect(events[0].wantsStack)
    }
}
