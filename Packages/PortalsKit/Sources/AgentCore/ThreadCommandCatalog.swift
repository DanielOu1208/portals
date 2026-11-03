import Foundation
import Observation

/// A single thread's project commands. Scope changes hide the old catalog at once;
/// even a host call that ignores cancellation cannot put it back.
@MainActor
@Observable
public final class ThreadCommandCatalog {
    public private(set) var catalog: CommandCatalog?

    private struct Scope: Hashable {
        var agent: Agent.ID
        var thread: ThreadRef.ID
        var folder: String?
    }

    @ObservationIgnored private var scope: Scope?
    @ObservationIgnored private var generation: UUID?
    @ObservationIgnored private var task: Task<Void, Never>?

    public init() {}

    /// Reuse one read per scope. An explicit refresh can replace a cached result, but
    /// never cancels another read of the same scope already in flight.
    @discardableResult
    public func refresh(for thread: ThreadRef, using host: any CommandRunning, force: Bool = false) -> Task<Void, Never>? {
        let next = Scope(agent: thread.agent, thread: thread.id, folder: thread.workingDirectory)
        if scope == next, task != nil || (!force && catalog != nil) { return nil }
        cancel()
        scope = next
        let token = UUID()
        generation = token
        let task = Task { [weak self] in
            do {
                let fetched = try await host.commandCatalog(for: thread.agent, in: thread.id)
                guard let self, generation == token, !Task.isCancelled else { return }
                catalog = fetched
            } catch {
                // The caller keeps its personal-only baseline while this scope is unavailable.
            }
            if self?.generation == token { self?.task = nil }
        }
        self.task = task
        return task
    }

    public func cancel() {
        generation = nil
        task?.cancel()
        task = nil
        scope = nil
        catalog = nil
    }
}
