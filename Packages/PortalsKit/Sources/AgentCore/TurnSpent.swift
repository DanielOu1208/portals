import Foundation

/// What one of the agent's turns spent, as the host tells it once the turn has ended: how
/// long it ran, and the tokens it took in and gave out, cached ones too, each counted once.
/// The thread's own agent's, not its subagents': each of those says its own. Either may be
/// missing: an agent that does not tell its tokens, a turn the host did not see begin.
public struct TurnSpent: Codable, Hashable, Sendable {
    public var seconds: TimeInterval?
    public var tokens: Int?

    public init(seconds: TimeInterval? = nil, tokens: Int? = nil) {
        self.seconds = seconds
        self.tokens = tokens
    }

    public var isEmpty: Bool { seconds == nil && tokens == nil }

    /// A token count as the footer says it: "950", "52.3k", "523k", "1.2M".
    public static func tokens(_ count: Int) -> String {
        func short(_ value: Double, _ unit: String, decimalsUnder limit: Double) -> String {
            let rounded = value < limit ? (value * 10).rounded() / 10 : value.rounded()
            let text = rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
            return text + unit
        }
        if count < 1_000 { return String(count) }
        if count < 999_500 { return short(Double(count) / 1_000, "k", decimalsUnder: 99.95) }
        return short(Double(count) / 1_000_000, "M", decimalsUnder: 99.95)
    }
}

extension Turn {
    /// How long the turn ran: the host's word where it gave one, else from its start to its end.
    public var duration: TimeInterval? {
        if let seconds = spent?.seconds { return seconds }
        guard let endedAt else { return nil }
        return max(0, endedAt.timeIntervalSince(startedAt))
    }

    /// The quiet line under a turn that has ended, finished, stopped or failed: how long it
    /// took and, where the host said, how many tokens it spent ("1m 42s · 52.3k tokens").
    /// While it runs, just the cumulative tokens so far. None for a turn of the app's own
    /// (a command's answer), or one over in under half a second that says no tokens.
    public var footer: String? {
        guard !isLocal else { return nil }
        let tokens = spent?.tokens.flatMap { $0 > 0 ? $0 : nil }
        let tokenText = tokens.map { $0 == 1 ? "1 token" : "\(TurnSpent.tokens($0)) tokens" }
        if isRunning { return tokenText.map { "\($0) so far" } }
        var parts: [String] = []
        if let duration, duration >= 0.5 || tokens != nil { parts.append(TurnLayout.shortDuration(duration)) }
        if let tokenText { parts.append(tokenText) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

public extension Array where Element == Turn {
    /// The turn whose footer lists the threads the agent started (the ask, 2026-10-19:
    /// always the latest): the last one that has ended and is the host's, not a command's
    /// answer or a notice. None before one has ended.
    var turnListingStartedThreads: Turn.ID? {
        last { !$0.isRunning && !$0.isLocal }?.id
    }
}
