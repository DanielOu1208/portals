import Foundation
import Testing
@testable import AgentCore

/// Work asked for several times is done once, a moment later, or at once when flushed,
/// and a flushed or cancelled wait never does it again.
///
/// Nothing here hangs on how soon a sleep ends: a loaded Mac may wake any of them late.
/// What holds under any load is that `Task.sleep` never wakes early, so work is never done
/// sooner than its delay after the ask it answers, measured by the clock it sleeps on.
@MainActor
@Suite struct CoalescedWorkTests {
    @MainActor final class Count {
        var value = 0
        /// When the work was last done.
        var doneAt: ContinuousClock.Instant?
    }

    /// Below the clock's rounding (a tick of `mach_continuous_time`, about 42 ns on Apple
    /// silicon), far below anything a wrong wait would show.
    private let rounding = Duration.milliseconds(1)

    /// Waits, a few milliseconds at a time, until `done` is true: given a minute, so only
    /// a hang ends it, and the checks after it then fail.
    private func waitUntil(_ done: () -> Bool) async throws {
        let until = ContinuousClock.now + .seconds(60)
        while !done(), ContinuousClock.now < until {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    @Test func asksWhileItWaitsAreDoneOnceAfterTheDelay() async throws {
        let count = Count()
        let delay = Duration.milliseconds(20)
        let work = CoalescedWork(after: delay)
        let asked = ContinuousClock.now
        for _ in 0..<3 { work.ask { count.value += 1; count.doneAt = .now } }
        #expect(count.value == 0)
        #expect(work.isPending)
        try await waitUntil { count.value > 0 }
        #expect(count.value == 1)
        #expect(!work.isPending)
        let first = try #require(count.doneAt)
        #expect(first - asked >= delay - rounding, "\(first - asked)")
        try await Task.sleep(for: .milliseconds(100))
        #expect(count.value == 1)

        // Asked again later: done again, its delay after that ask.
        let askedAgain = ContinuousClock.now
        work.ask { count.value += 1; count.doneAt = .now }
        try await waitUntil { count.value > 1 }
        #expect(count.value == 2)
        let second = try #require(count.doneAt)
        #expect(second - askedAgain >= delay - rounding, "\(second - askedAgain)")
    }

    @Test func flushDoesTheWaitingWorkAtOnceAndOnlyOnce() async throws {
        let count = Count()
        let work = CoalescedWork(after: .milliseconds(30))
        work.flush()
        #expect(count.value == 0)

        work.ask { count.value += 1 }
        work.flush()
        #expect(count.value == 1)
        #expect(!work.isPending)
        try await Task.sleep(for: .milliseconds(150))
        #expect(count.value == 1)
    }

    @Test func aFlushedWaitDoesNotEndTheNextAsk() async throws {
        let count = Count()
        let delay = Duration.milliseconds(400)
        let work = CoalescedWork(after: delay)
        work.ask { count.value += 1 }
        work.flush()
        #expect(count.value == 1)
        // Asked again later, its moment 400 ms after that, while the first wait's moment
        // comes about 200 ms after it.
        try await Task.sleep(for: .milliseconds(200))
        let asked = ContinuousClock.now
        work.ask { count.value += 10; count.doneAt = .now }
        #expect(work.isPending)
        try await waitUntil { count.value > 1 }
        #expect(count.value == 11)
        #expect(!work.isPending)
        // The second ask waited for its own moment: had the first wait done it, it would
        // have come about 200 ms after the ask, however loaded the Mac.
        let done = try #require(count.doneAt)
        #expect(done - asked >= delay - rounding, "\(done - asked)")
        try await Task.sleep(for: .milliseconds(100))
        #expect(count.value == 11)
    }

    @Test func cancelledWorkIsNeverDone() async throws {
        let count = Count()
        let work = CoalescedWork(after: .milliseconds(20))
        work.ask { count.value += 1 }
        work.cancel()
        #expect(!work.isPending)
        try await Task.sleep(for: .milliseconds(150))
        #expect(count.value == 0)
        work.flush()
        #expect(count.value == 0)
    }
}
