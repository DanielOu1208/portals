import Foundation

/// Test connection in a host's sheet: whether a try runs, and how the last one went. One
/// try counts at a time, the latest begun; a try stopped (a field changed, the sheet
/// closed) ends showing nothing, and one stopped before it began never shows its spinner:
/// such a try began all the same once its task got its first turn, and its stopped end left
/// the spinner and the disabled button up for good.
public struct ConnectionTrial: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case none, running
        case passed(agents: Int)
        case failed(String)
    }

    /// How a try went: the agents the host listed, or why it failed.
    public enum Outcome: Equatable, Sendable {
        case success(Int)
        case failure(String)
    }

    public private(set) var phase = Phase.none
    /// The try that counts.
    private var current: UUID?

    public init() {}

    /// A try begins, in place of one under way, unless it was stopped already: its id, or
    /// nil for one that does not begin.
    public mutating func begin(cancelled: Bool) -> UUID? {
        guard !cancelled else { return nil }
        let id = UUID()
        current = id
        phase = .running
        return id
    }

    /// The try `id` ended: how it went shows, or nothing when it was stopped. One that no
    /// longer counts changes nothing.
    public mutating func end(_ id: UUID?, with outcome: Outcome, cancelled: Bool) {
        guard let id, id == current else { return }
        current = nil
        guard !cancelled else {
            phase = .none
            return
        }
        switch outcome {
        case let .success(agents): phase = .passed(agents: agents)
        case let .failure(reason): phase = .failed(reason)
        }
    }

    /// What it tried changed: no try counts, and nothing shows.
    public mutating func reset() {
        current = nil
        phase = .none
    }
}
