import Foundation
import Synchronization

/// Work given a time to answer in: its result, or `Deadline.Passed` once the time is up,
/// whichever comes first, without waiting for work that does not hear it was cancelled
/// (a connection's attempt waits out its own limits, 20 s for a ticket and 15 for the
/// host's ready). The work is cancelled once the answer is in, either way; so is the
/// caller's wait when the caller is cancelled (`CancellationError`).
public enum Deadline {
    /// The time was up before the work answered.
    public struct Passed: Error, Equatable {
        public init() {}
    }

    public static func run<T: Sendable>(
        within limit: Duration, _ work: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let race = Race<T>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<T, any Error>) in
                race.wait(with: waiter)
                race.add(Task {
                    do { race.finish(.success(try await work())) } catch { race.finish(.failure(error)) }
                })
                race.add(Task {
                    try? await Task.sleep(for: limit)
                    race.finish(.failure(Passed()))
                })
            }
        } onCancel: {
            race.finish(.failure(CancellationError()))
        }
    }

    /// The first answer, given once; the tasks that race to give it are cancelled then.
    private final class Race<T: Sendable>: Sendable {
        private struct State {
            var waiter: CheckedContinuation<T, any Error>?
            var answer: Result<T, any Error>?
            var tasks: [Task<Void, Never>] = []
        }

        private let state = Mutex(State())

        func wait(with waiter: CheckedContinuation<T, any Error>) {
            let answer = state.withLock { state -> Result<T, any Error>? in
                if state.answer == nil { state.waiter = waiter }
                return state.answer
            }
            // Cancelled before the wait began.
            if let answer { waiter.resume(with: answer) }
        }

        func add(_ task: Task<Void, Never>) {
            let answered = state.withLock { state -> Bool in
                if state.answer == nil { state.tasks.append(task) }
                return state.answer != nil
            }
            if answered { task.cancel() }
        }

        func finish(_ answer: Result<T, any Error>) {
            let (waiter, tasks) = state.withLock { state -> (CheckedContinuation<T, any Error>?, [Task<Void, Never>]) in
                guard state.answer == nil else { return (nil, []) }
                state.answer = answer
                defer { state.waiter = nil; state.tasks = [] }
                return (state.waiter, state.tasks)
            }
            tasks.forEach { $0.cancel() }
            waiter?.resume(with: answer)
        }
    }
}
