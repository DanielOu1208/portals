import Foundation

public struct TodoItem: Codable, Hashable, Sendable {
    public enum Status: String, Codable, Hashable, Sendable {
        /// `cancelled`: an item the agent dropped (Hermes's and Cursor's lists have them),
        /// no step still to take. Shown struck through, as one done is. Never saved as a
        /// status (`TodoItem.encode`).
        case pending, inProgress = "in_progress", completed, cancelled

        /// A saved plan is part of a saved transcript: a status this app does not know (a
        /// later app's) reads as an item still to do, rather than costing the transcript.
        public init(from decoder: any Decoder) throws {
            self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .pending
        }
    }

    public var text: String
    public var status: Status
    /// The item worded as it runs ("Running the tests"), where the agent gives one
    /// (Claude Code's `activeForm`): while it is in progress, what the status line says the
    /// agent is working on (`StatusHeadline`).
    public var activeForm: String?

    public init(text: String, status: Status, activeForm: String? = nil) {
        self.text = text
        self.status = status
        self.activeForm = activeForm
    }

    private enum CodingKeys: String, CodingKey {
        case text, status, activeForm, cancelled
    }

    /// Saved, a cancelled item's `status` is `completed`, with `cancelled: true` beside it:
    /// a build from before `cancelled` throws on a status it does not know, which cost the
    /// whole saved transcript of the thread, and it ignores a key it does not know, so it
    /// shows the item as done, the nearest it has (Codex's review of the round 4 app fixes).
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(text, forKey: .text)
        try container.encode(status == .cancelled ? .completed : status, forKey: .status)
        try container.encodeIfPresent(activeForm, forKey: .activeForm)
        if status == .cancelled { try container.encode(true, forKey: .cancelled) }
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decode(String.self, forKey: .text)
        let cancelled = try container.decodeIfPresent(Bool.self, forKey: .cancelled) == true
        status = cancelled ? .cancelled : try container.decode(Status.self, forKey: .status)
        activeForm = try container.decodeIfPresent(String.self, forKey: .activeForm)
    }
}

/// The latest checklist an agent wrote, kept structured rather than parsed by a view.
public struct TodoPlan: Codable, Hashable, Sendable {
    public var items: [TodoItem]

    public init(items: [TodoItem]) {
        self.items = items
    }

    public var completedCount: Int { items.count { $0.status == .completed } }
    public var current: TodoItem? {
        currentIndex.map { items[$0] }
    }

    /// One line of progress; empty updates remove the plan from the run status.
    public var summary: String? {
        guard !items.isEmpty else { return nil }
        guard let index = currentIndex else { return "Plan complete · \(items.count) of \(items.count)" }
        return "Step \(index + 1) of \(items.count) · \(items[index].text)"
    }

    private var currentIndex: Int? {
        items.firstIndex { $0.status == .inProgress } ?? items.firstIndex { $0.status == .pending }
    }

    /// TodoWrite's numbered status lines. Malformed input stays visible as raw tool input.
    public static func parse(_ text: String) -> TodoPlan? {
        var items: [TodoItem] = []
        for line in text.split(whereSeparator: \.isNewline) {
            let line = line.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }
            guard let dot = line.firstIndex(of: "."), dot != line.startIndex,
                  line[..<dot].allSatisfy(\.isNumber) else { return nil }
            let rest = line[line.index(after: dot)...].trimmingCharacters(in: .whitespaces)
            guard rest.first == "[", let end = rest.firstIndex(of: "]"),
                  let status = TodoItem.Status(rawValue: String(rest.dropFirst().prefix(upTo: end))) else { return nil }
            let task = rest[rest.index(after: end)...].trimmingCharacters(in: .whitespaces)
            guard !task.isEmpty else { return nil }
            items.append(TodoItem(text: task, status: status))
        }
        return TodoPlan(items: items)
    }
}

extension Transcript {
    public var currentPlan: TodoPlan? { latestPlan?.plan }

    var latestPlan: (turn: UUID, plan: TodoPlan)? {
        for turn in turns.reversed() {
            for item in turn.items.reversed() {
                if case let .tool(run) = item.content, run.state == .succeeded, let plan = run.plan { return (turn.id, plan) }
            }
        }
        return nil
    }
}
