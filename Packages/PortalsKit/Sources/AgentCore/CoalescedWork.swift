import Foundation

/// Work asked for several times in a short while, done once a moment after the first ask
/// (`ask`), or at once when it cannot wait any longer (`flush`): for work that costs the
/// main thread enough to be kept away from a launch's first frame, as the agents'
/// notification pictures (`Fleet`). Whatever the work reads, it reads when it is done.
@MainActor
public final class CoalescedWork {
    private let delay: Duration
    private var pending: (task: Task<Void, Never>, work: @MainActor () -> Void)?

    public init(after delay: Duration) {
        self.delay = delay
    }

    /// Whether work is asked for and not done yet.
    public var isPending: Bool { pending != nil }

    /// Does `work` `delay` from now, unless work is already waiting: asks until then are
    /// folded into that one.
    public func ask(_ work: @escaping @MainActor () -> Void) {
        guard pending == nil else { return }
        let task = Task { [weak self, delay] in
            try? await Task.sleep(for: delay)
            // Done already (`flush`) or let go (`cancel`): nothing more, whatever was
            // asked since.
            guard !Task.isCancelled, let self, let pending = self.pending else { return }
            self.pending = nil
            pending.work()
        }
        pending = (task, work)
    }

    /// Does the waiting work at once, if there is any: before the app goes to the
    /// background, where it may be suspended or ended before the moment comes.
    public func flush() {
        guard let pending else { return }
        pending.task.cancel()
        self.pending = nil
        pending.work()
    }

    /// Lets the waiting work go undone: what it would do was just done another way.
    public func cancel() {
        pending?.task.cancel()
        pending = nil
    }
}
