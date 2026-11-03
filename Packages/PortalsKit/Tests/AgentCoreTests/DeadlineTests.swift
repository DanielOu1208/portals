import Foundation
import Synchronization
import Testing
@testable import AgentCore

@Suite struct DeadlineTests {
    /// Work that keeps going whatever: it does not hear it was cancelled, as a connection's
    /// attempt waits out its own limits. It says once it is over.
    private static func deaf(for seconds: Double, ended: Flag) async -> Int {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end { try? await Task.sleep(for: .milliseconds(10)) }
        ended.set()
        return 1
    }

    final class Flag: Sendable {
        private let value = Mutex(false)
        func set() { value.withLock { $0 = true } }
        var isSet: Bool { value.withLock { $0 } }
    }

    @Test func workThatAnswersInTimeGivesItsAnswer() async throws {
        let answer = try await Deadline.run(within: .seconds(5)) { 42 }
        #expect(answer == 42)
    }

    @Test func workThatFailsInTimeGivesItsError() async {
        struct Refused: Error {}
        await #expect(throws: Refused.self) {
            try await Deadline.run(within: .seconds(5)) { () async throws -> Int in throw Refused() }
        }
    }

    /// The time up, the answer is `Passed` at once, not once the deaf work ends.
    @Test func workPastItsTimeIsLeftBehind() async {
        let ended = Flag()
        let started = ContinuousClock.now
        await #expect(throws: Deadline.Passed.self) {
            try await Deadline.run(within: .milliseconds(100)) { await Self.deaf(for: 2, ended: ended) }
        }
        #expect(ContinuousClock.now - started < .seconds(1.5))
        #expect(!ended.isSet)
    }

    /// The work hears it is cancelled once the time is up.
    @Test func workPastItsTimeIsCancelled() async {
        let cancelled = Flag()
        await #expect(throws: Deadline.Passed.self) {
            try await Deadline.run(within: .milliseconds(50)) { () async throws -> Int in
                try? await Task.sleep(for: .seconds(5))
                if Task.isCancelled { cancelled.set() }
                return 1
            }
        }
        try? await Task.sleep(for: .milliseconds(200))
        #expect(cancelled.isSet)
    }

    /// The caller cancelled (a sheet closed), its wait ends at once.
    @Test func aCancelledCallerStopsWaiting() async {
        let ended = Flag()
        let started = ContinuousClock.now
        let wait = Task {
            try await Deadline.run(within: .seconds(30)) { await Self.deaf(for: 2, ended: ended) }
        }
        try? await Task.sleep(for: .milliseconds(100))
        wait.cancel()
        let result = await wait.result
        #expect(throws: CancellationError.self) { try result.get() }
        #expect(ContinuousClock.now - started < .seconds(1.5))
    }
}
