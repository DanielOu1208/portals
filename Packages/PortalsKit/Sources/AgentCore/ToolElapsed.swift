import Foundation

/// How long a tool call has run, for the status line while it runs with nothing to show
/// (2026-10-23: a long Claude Code command shows its time so far, since Claude Code
/// sends nothing while one runs). Said only past a few seconds, when the wait is long enough
/// to wonder about: "12s", "1m 12s", "1h 4m".
public enum ToolElapsed {
    /// Below this, nothing is said: most calls are over by then.
    public static let shownFrom: TimeInterval = 5

    public static func text(_ seconds: TimeInterval) -> String? {
        guard seconds >= shownFrom else { return nil }
        let whole = Int(seconds)
        let hours = whole / 3600, minutes = whole % 3600 / 60, rest = whole % 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        if minutes > 0 { return "\(minutes)m \(rest)s" }
        return "\(rest)s"
    }
}
