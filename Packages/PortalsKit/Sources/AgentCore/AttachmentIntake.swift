import Foundation
import Observation

/// Attachment work belonging to one composer. Send waits for every batch; leaving the
/// composer invalidates its tokens before cancelling, including reads that finish late.
@MainActor
@Observable
public final class AttachmentIntake {
    public typealias Token = UUID

    private var tasks: [Token: Task<Void, Never>] = [:]

    public init() {}

    public var isPending: Bool { !tasks.isEmpty }

    /// A cancelled or let-go batch must not append attachments, errors or focus changes.
    public func accepts(_ token: Token) -> Bool {
        tasks[token]?.isCancelled == false
    }

    /// Registers the batch before its task can run, so Send cannot overtake its start.
    @discardableResult
    public func run(
        cleanup: @escaping @MainActor () -> Void = {},
        _ work: @escaping @MainActor (Token) async -> Void
    ) -> Task<Void, Never> {
        let token = Token()
        let task = Task { [weak self] in
            defer {
                self?.tasks[token] = nil
                cleanup()
            }
            guard self != nil, !Task.isCancelled else { return }
            await work(token)
        }
        tasks[token] = task
        return task
    }

    public func cancelAll() {
        let pending = Array(tasks.values)
        tasks.removeAll()
        for task in pending { task.cancel() }
    }
}
