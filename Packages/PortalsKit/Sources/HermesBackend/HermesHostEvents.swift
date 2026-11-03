import AgentCore
import Foundation

/// The messages Hermes writes to its own agents, and what the app shows in their place.
///
/// Hermes starts turns by itself: when a background process or other agents finish, when
/// a `/loop` task comes due, when it picks up a turn that was cut short. It does so by
/// putting a message in the conversation, in the user's place, written for the model:
/// a bracketed header and paragraphs of instructions. Most carry a `display_kind` that
/// says what they are; a `/loop` wakeup carries none and is known by its header. None of
/// it is something the user said, so none of it is shown as their message.
enum HermesHostEvents {
    /// What a stored message in the user's place is.
    enum Row: Equatable {
        /// The user's own words. `steered` when they were said during a run.
        case message(String, steered: Bool)
        /// The host set the agent going. One line says why.
        case event(HostEvent)
        /// A wake with nothing to say for itself: only the agent's reply to it shows.
        case hidden
    }

    static func row(_ message: JSONValue) -> Row {
        let text = message["text"]?.stringValue ?? ""
        let display = displayText(message["display_metadata"])
        switch message["display_kind"]?.stringValue {
        case nil, "skill_invocation":
            return untagged(text)
        case "steer":
            return .message(text, steered: true)
        case "hidden":
            return .hidden
        case "process_complete":
            return .event(HostEvent(.backgroundProcess, display ?? "Background process finished"))
        case "async_delegation_complete":
            return .event(HostEvent(.backgroundAgents, display ?? "Background agents finished"))
        case "auto_continue":
            return .event(HostEvent(.resumed, "Picked up the interrupted turn"))
        case "model_switch":
            return .event(HostEvent(.other, "Model changed"))
        case "personality_switch":
            return .event(HostEvent(.other, "Personality changed"))
        case "internal_notification":
            // What a messaging gateway tells its agent. Known by what it opens with,
            // after the name of the chat it came through.
            return .event(announced(text.replacing(#/^\[[^\]\n]{1,40}\]\s*/#, with: "")) ?? HostEvent(.other, "Automatic message"))
        case let kind?:
            // A kind this app does not know is still not the user's words.
            return .event(HostEvent(.other, "Automatic step (\(kind.replacing("_", with: " ")))"))
        }
    }

    /// A message with no kind: the user's, unless it opens the way Hermes's own do.
    private static func untagged(_ text: String) -> Row {
        // Every one of Hermes's own opens with a bracket, and the user's words seldom do:
        // those are known without the rest, which in a long history cost more than all
        // else in reading it (the patterns below are made anew each time).
        guard text.unicodeScalars.first(where: { !CharacterSet.whitespacesAndNewlines.contains($0) }) == "[" else {
            return .message(text, steered: false)
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let wakeup = trimmed.firstMatch(of: #/^\[/loop wakeup \#(\d+)(?:, ([^\]\n]+))?\]\s*\nRecurring task: ([^\n]*)/#) {
            let cadence = wakeup.2.map { " · \($0)" } ?? ""
            return .event(HostEvent(.recurringTask, "Recurring task #\(wakeup.1)\(cadence): \(oneLine(String(wakeup.3)))"))
        }
        // A heartbeat from a background process, as Hermes stored it before it had a
        // kind for it; and its notes to the model, which it also filters itself.
        if trimmed.contains(#/^\[Background process \S+ heartbeat \#\d+ /#) || trimmed.hasPrefix("[System:") || trimmed.hasPrefix("[System note:") {
            return .hidden
        }
        // The user's request, said again after the conversation was compressed: theirs,
        // without the note to the model in front of it.
        if trimmed.hasPrefix(stillInProgress) {
            return .message(trimmed.dropFirst(stillInProgress.count).trimmingCharacters(in: .whitespacesAndNewlines), steered: false)
        }
        return .message(text, steered: false)
    }

    private static let stillInProgress =
        "[STILL IN PROGRESS — this is the active request, restated after the compaction boundary because it was not finished yet. "
        + "Continue it; do not start over.]"

    /// The one-line text Hermes prepares for showing, when it did.
    private static func displayText(_ metadata: JSONValue?) -> String? {
        // An older Hermes hands the metadata over as JSON text.
        let metadata = metadata?.stringValue.flatMap { try? JSONValue.parse($0) } ?? metadata
        guard let text = metadata?["display_text"]?.stringValue else { return nil }
        let line = oneLine(text)
        return line.isEmpty ? nil : line
    }

    // MARK: Said while it happens

    /// What a live status line announces, when it is the host saying it is about to
    /// start a turn by itself. `kind` is the status line's own.
    static func announced(statusKind kind: String?, text: String) -> HostEvent? {
        switch kind {
        case "loop":
            // "↻ /loop wakeup #3 firing…"
            guard let tick = text.firstMatch(of: #//loop wakeup \#(\d+)/#) else { return nil }
            return HostEvent(.recurringTask, "Recurring task #\(tick.1)")
        case "process":
            return announced(text) ?? HostEvent(.other, oneLine(HermesEventMapper.plain(text)))
        default:
            return nil
        }
    }

    /// A notification by the words it opens with: Hermes's short titles ("Background
    /// Process Finished: pytest -q") and the headers of its messages to the model.
    private static func announced(_ text: String) -> HostEvent? {
        let line = oneLine(HermesEventMapper.plain(text))
        let lowered = line.lowercased()
        if lowered.hasPrefix("subagent") || lowered.contains("async delegation") {
            return HostEvent(.backgroundAgents, lowered.contains("async delegation") ? "Background agents finished" : line)
        }
        if lowered.hasPrefix("background process") || lowered.contains("background process") {
            return HostEvent(.backgroundProcess, lowered.hasPrefix("background process") ? line : "Background process finished")
        }
        if lowered.hasSuffix("background processes finished") || lowered.contains("background processes completed") {
            return HostEvent(.backgroundProcess, lowered.hasSuffix("background processes finished") ? line : "Background processes finished")
        }
        return nil
    }

    /// The first line with something on it, without the run of spaces a terminal
    /// layout leaves, and not longer than a line or two on a phone.
    private static func oneLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).lazy
            .map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
            .first { !$0.isEmpty } ?? ""
        return line.count <= 140 ? line : line.prefix(139).trimmingCharacters(in: .whitespaces) + "…"
    }
}
