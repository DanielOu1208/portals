import Foundation

/// What the agent says it is working on, in its own words, on the running turn's status line
/// in place of "Thinking…" (2026-10-26: "there should be like, a summary on what the
/// agent is currently working on"; the answer on where: in place of "Thinking…", a call
/// running still taking the line). Taken in the app, so it works for every agent and every
/// bridge already installed, from:
/// - the bold title opening each part of a GPT model's reasoning summary, a line by itself
///   ("**Validating prime numbers**", then a blank line, then prose): Codex always, Droid and
///   Pi on such a model. Claude's thinking has none. A title is taken once its line is closed
///   (the line break after its closing `**`, or the thought's end), not while it streams in
///   pieces, and not a bold run that opens a line of prose ("**Note:** …");
/// - the wording of Claude Code's to-do in progress, as it runs (`TodoItem.activeForm`,
///   "Running the tests"), from a list written that took, when it changes or nothing in
///   the work under way has said what it is about yet;
/// - Claude Code's summary of a run of its tool calls (`ThreadEvent.headline`, a bridge's
///   `status_headline`), while one of the calls it sums up is in the work under way: it is
///   made after the run, and can come once the agent has said something.
/// A headline holds until a newer one comes, whichever its source, through the thinking and
/// the calls that take the line's note down (`ThreadState.statusLine`); it goes when the
/// agent says something (the stretch of work it belongs to is over) and at the turn's end.
public enum StatusHeadline {
    /// The longest a title may be: a longer bold line is prose, not a heading.
    static let longest = 200

    /// The title a whole line is: `**Validating prime numbers**` is "Validating prime
    /// numbers"; nil for any other line.
    public static func title(of line: Substring) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.count > 4, trimmed.count <= longest + 4, trimmed.hasPrefix("**"), trimmed.hasSuffix("**") else { return nil }
        let inner = trimmed.dropFirst(2).dropLast(2)
        // "**a** and **b**" is two bold runs, not one title.
        guard !inner.contains("**") else { return nil }
        let words = inner.trimmingCharacters(in: .whitespaces)
        return words.isEmpty ? nil : words
    }

    /// The newest title among the lines `delta` closes, appended to a thought that read
    /// `text`: only lines whose line break it brings, so a title streaming in pieces
    /// ("**Valid", "ating prime numbers**") is taken once, whole. Reads the thought's last
    /// unclosed line and the delta, never the whole thought.
    static func title(closedBy delta: String, after text: String) -> String? {
        guard delta.contains(where: \.isNewline) else { return nil }
        let open = text.lastIndex(where: \.isNewline).map { text[text.index(after: $0)...] } ?? text[...]
        let lines = (String(open) + delta).split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        // The last piece is after the delta's last line break: not closed yet.
        return lines.dropLast().reversed().lazy.compactMap { title(of: $0) }.first
    }

    /// The title a thought ends with, its last line having no line break after it: taken as
    /// the thought ends, when the agent moves on.
    static func title(ending text: String) -> String? {
        let last = text.lastIndex(where: \.isNewline).map { text[text.index(after: $0)...] } ?? text[...]
        return title(of: last)
    }

    /// The newest title anywhere in a thought, for a stretch of work read whole, and where
    /// its line ends (UTF-8 bytes into the thought): its last line counts only once the
    /// thought has ended (`closed`), as it streams in.
    static func latestTitle(in text: String, closed: Bool) -> (title: String, end: Int)? {
        var lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        if !closed { lines.removeLast() }
        for line in lines.reversed() {
            if let title = title(of: line) { return (title, text.utf8.distance(from: text.startIndex, to: line.endIndex)) }
        }
        return nil
    }

    /// The wording of the to-do in progress, where the agent gives one.
    public static func wording(of plan: TodoPlan?) -> String? {
        plan?.items.first { $0.status == .inProgress }?.activeForm
    }

    /// The newest headline in a stretch of work read whole (a thread opened again while it
    /// runs): its last title or the wording of a list written that took, newest item first,
    /// with where it is (for a title, also where in its thought).
    static func latest(in items: ArraySlice<TurnItem>) -> (text: String, at: ArraySlice<TurnItem>.Index, end: Int?)? {
        for index in items.indices.reversed() {
            switch items[index].content {
            case let .reasoning(reasoning):
                if let found = latestTitle(in: reasoning.text, closed: reasoning.endedAt != nil) { return (found.title, index, found.end) }
            case let .tool(run):
                if run.state == .succeeded, let wording = wording(of: run.plan) { return (wording, index, nil) }
            default:
                continue
            }
        }
        return nil
    }
}

/// A headline the agent gave, with the stretch of work it was given in.
struct SpokenHeadline: Hashable, Sendable {
    var text: String
    var stretch: ThreadState.Stretch
    /// Where in the stretch it was given: what comes after it in a copy of the thread taken
    /// from the host is newer.
    var mark: Mark?
    /// A summary from the host (`ThreadEvent.headline`), which the transcript does not keep.
    var isSummary = false

    /// The stretch's last item when a headline was given: a tool call by its call's id (a copy
    /// from the host makes its rows anew, with ids of their own), any other item by its id,
    /// else by its place in the stretch; for a thought, how much of it there was then.
    struct Mark: Hashable, Sendable {
        var call: String?
        var item: UUID
        var place: Int
        var read: Int?

        init?(_ items: ArraySlice<TurnItem>) {
            guard let last = items.last else { return nil }
            item = last.id
            place = items.count - 1
            switch last.content {
            case let .tool(run): call = run.id
            case let .reasoning(reasoning): read = reasoning.text.utf8.count
            default: break
            }
        }

        /// The item in `items`, a copy of the stretch.
        func index(in items: ArraySlice<TurnItem>) -> ArraySlice<TurnItem>.Index? {
            if let call, let found = items.firstIndex(where: { if case let .tool(run) = $0.content { run.id == call } else { false } }) {
                return found
            }
            if let found = items.firstIndex(where: { $0.id == item }) { return found }
            return place < items.count ? items.index(items.startIndex, offsetBy: place) : nil
        }
    }
}

extension ThreadState {
    /// A stretch of work in the running turn: what came after the last thing said in it
    /// (`TurnItem.isSaid`, as `TurnLayout` folds the work), by the turn and that item.
    struct Stretch: Hashable, Sendable {
        var turn: UUID
        /// The last thing said before it; nil when nothing has been (a turn the host began).
        var after: UUID?
    }

    /// What the agent says it is working on (`StatusHeadline`), while the turn runs and
    /// until it says something: nil otherwise.
    public var headline: String? {
        guard isRunning, let spokenHeadline, spokenHeadline.stretch == currentStretch?.stretch else { return nil }
        return spokenHeadline.text
    }

    /// The running turn's stretch of work under way, and its items.
    var currentStretch: (stretch: Stretch, items: ArraySlice<TurnItem>)? {
        guard let turn = transcript.turns.last, turn.isRunning else { return nil }
        let said = turn.items.lastIndex { $0.isSaid && !$0.isCardAnswer }
        let items = said.map { turn.items[turn.items.index(after: $0)...] } ?? turn.items[...]
        return (Stretch(turn: turn.id, after: said.map { turn.items[$0].id }), items)
    }

    /// The agent gave a headline in the work under way.
    mutating func takeHeadline(_ text: String?, isSummary: Bool = false) {
        guard let text, let (stretch, items) = currentStretch else { return }
        spokenHeadline = SpokenHeadline(text: text, stretch: stretch, mark: SpokenHeadline.Mark(items), isSummary: isSummary)
    }

    /// A to-do list written that took: its item in progress, worded as it runs, when that
    /// changed or the work under way has no headline yet (the agent said something since).
    /// A list with nothing in progress lets the same wording count as new when it comes back.
    mutating func takeWording(of plan: TodoPlan?) {
        guard let plan else { return }
        guard let wording = StatusHeadline.wording(of: plan) else {
            takenWording = nil
            return
        }
        guard wording != takenWording || headline == nil else { return }
        takenWording = wording
        takeHeadline(wording)
    }

    /// A summary of a run of calls (`ThreadEvent.headline`): taken while one of the calls it
    /// sums up is in the work under way, or when it names none.
    mutating func takeSummary(_ text: String, of toolIDs: [String]) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let items = currentStretch?.items else { return }
        let covers = toolIDs.isEmpty || items.contains { item in
            if case let .tool(run) = item.content { toolIDs.contains(run.id) } else { false }
        }
        if covers { takeHeadline(trimmed, isSummary: true) }
    }

    /// The thread taken whole from the host: the newest headline the stretch under way tells
    /// of, read whole; one given here stays when nothing in the host's copy is newer (a
    /// summary, which the copy does not keep, after the stretch's last title).
    mutating func readHeadline() {
        takenWording = StatusHeadline.wording(of: currentPlan)
        guard let (stretch, items) = currentStretch else {
            spokenHeadline = nil
            return
        }
        let latest = StatusHeadline.latest(in: items)
        if let kept = spokenHeadline, kept.stretch == stretch, let mark = kept.mark, let keptAt = mark.index(in: items) {
            // Newer: after the item it was given at; in that item, a title read whole (the same
            // or newer), but for a summary only one past what the thought held when it came.
            let newer = latest.map { found in
                found.at > keptAt || (found.at == keptAt && (!kept.isSummary || (found.end ?? 0) > (mark.read ?? .max)))
            } ?? false
            if !newer { return }
        }
        spokenHeadline = latest.map { SpokenHeadline(text: $0.text, stretch: stretch, mark: SpokenHeadline.Mark(items[...$0.at])) }
    }
}
