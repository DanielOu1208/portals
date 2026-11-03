import Foundation

/// How a turn is laid out. What the agent says stays in view, its answer and whatever
/// it writes on the way, and the work before each thing said (reasoning, tool calls,
/// requests) folds into a "4 steps · 38s" line as soon as it is said. The work since
/// the last thing said, while the turn runs, takes one line (`UnderWay`): the status
/// line under the turn says what the agent is doing now (`ThreadState.runStatus`: the
/// tool call running, or that it is thinking, with the newest words of its thought as it
/// streams), and what it did before folds into that same line ("4 steps"), opened with a
/// tap (2026-10-19 and 2026-10-20). When the turn is over, that work folds like
/// the rest.
public enum TurnLayout {
    /// A turn's pieces, and the work under way when it runs.
    public struct Layout: Hashable, Sendable {
        public var pieces: [Piece]
        /// The work since the agent last said something, while the turn runs: drawn as
        /// one line where the status line goes. Nil when there is none, and once the turn
        /// is over.
        public var underWay: UnderWay?
    }

    public enum Piece: Identifiable, Hashable, Sendable {
        case item(TurnItem)
        case steps(Steps)

        public var id: UUID {
            switch self {
            case let .item(item): item.id
            case let .steps(steps): steps.id
            }
        }
    }

    /// The folded work of a finished turn.
    public struct Steps: Identifiable, Hashable, Sendable {
        /// The first folded item's id, so the fold keeps its identity as the turn is redrawn.
        public var id: UUID
        public var items: [TurnItem]
        public var toolCount: Int
        public var failedCount: Int
        /// How long the work took. For steps that do not say when they ran (read back
        /// from the host's history), the whole turn when this is its only fold.
        public var duration: TimeInterval?

        /// "4 steps · 38s", or "Thought for 12s" when there was only reasoning.
        public var summary: String {
            let time = duration.map(TurnLayout.shortDuration)
            guard toolCount > 0 else { return TurnLayout.thought(for: duration) }
            let steps = toolCount == 1 ? "1 step" : "\(toolCount) steps"
            return [steps, time].compactMap(\.self).joined(separator: " · ")
        }
    }

    /// The work since the agent last said something, in a running turn, as one line: what
    /// the agent does now (the status line's: the tool call running, "Thinking ·" with the
    /// newest words of the thought streaming in the same line), with what it did before
    /// folded into the line ("4 steps"), shown when the line is opened. Notices and the
    /// like in that stretch are listed above the line as they are.
    public struct UnderWay: Hashable, Sendable {
        /// The stretch's first item (a step, or a notice before it): the fold the work becomes once the agent
        /// says something has the same, so a line left open stays open.
        public var id: UUID
        /// Work to list when opened, including running tool rows with their live output.
        /// The current thought is separate so it has just one live rendering.
        public var items: [TurnItem]
        /// The finished work, oldest first, used only for the completed-step count.
        public var done: [TurnItem]
        /// The reasoning streaming now, when it is the latest thing the agent did and it
        /// sends its text: its newest words in the line (and all of it when the line is
        /// opened), folded away with the rest as soon as the agent moves on.
        public var thought: Reasoning?
        /// The id of the thought's item: each thought's words start in the line anew.
        public var thoughtID: UUID?
        /// The agent sent a thought's text in this stretch, now or before a tool call: the
        /// room its thoughts are shown in under the line stays open until the agent says
        /// something, so that the chat does not move at each step (2026-10-20).
        public var hasThought = false

        /// What the line says of the work done: "4 steps" (tool calls and answered
        /// requests), "Thought for 12s" when the agent has only reasoned so far; nil with
        /// nothing done yet. No time beside the steps: the line stays short.
        public var summary: String? {
            guard !done.isEmpty else { return nil }
            let steps = done.count(where: \.isStep)
            if steps > 0 { return steps == 1 ? "1 step" : "\(steps) steps" }
            return TurnLayout.thought(for: TurnLayout.span(of: done))
        }
    }

    /// "Thought for 12s"; "Thought" under a second (Claude's summarized thinking often comes
    /// at once, just before the words), or when it is not known how long.
    static func thought(for duration: TimeInterval?) -> String {
        guard let duration, duration >= 1 else { return "Thought" }
        return "Thought for \(shortDuration(duration))"
    }

    public static func pieces(for turn: Turn) -> [Piece] {
        layout(for: turn).pieces
    }

    public static func layout(for turn: Turn) -> Layout {
        // Stretches of items between the things said (and the message that started the
        // turn). In each, the work runs from its first item to its last tool call,
        // reasoning or request; what follows that is shown as it is.
        var stretches: [[TurnItem]] = [[]]
        var said: [TurnItem] = []
        // The answers given on a card show in its questions' row, not as a message.
        for item in turn.items where !item.isCardAnswer {
            if item.isSaid {
                said.append(item)
                stretches.append([])
            } else {
                stretches[stretches.count - 1].append(item)
            }
        }
        let folds = turn.isRunning ? 0 : stretches.count { $0.contains(where: \.isWork) }

        var pieces: [Piece] = []
        var underWay: UnderWay?
        for (index, stretch) in stretches.enumerated() {
            if turn.isRunning, index == stretches.count - 1 {
                // The work under way: nothing has been said since. It is the status
                // line's; the rest is listed as it is.
                pieces += stretch.filter { !$0.isWork }.map(Piece.item)
                underWay = Self.underWay(stretch)
            } else if let last = stretch.lastIndex(where: \.isWork) {
                let folded = Array(stretch[...last])
                let tools = folded.compactMap { item -> ToolRun? in
                    if case let .tool(run) = item.content { run } else { nil }
                }
                let whole = turn.endedAt.map { $0.timeIntervalSince(turn.startedAt) }
                pieces.append(.steps(Steps(
                    id: folded[0].id,
                    items: folded,
                    toolCount: tools.count,
                    failedCount: tools.count { $0.state == .failed },
                    duration: span(of: folded) ?? (folds == 1 ? whole : nil)
                )))
                pieces += stretch[(last + 1)...].map(Piece.item)
            } else {
                pieces += stretch.map(Piece.item)
            }
            if index < said.count {
                pieces.append(.item(said[index]))
            }
        }
        return Layout(pieces: pieces, underWay: underWay)
    }

    /// The work in `stretch`, the items since the agent last said something in a
    /// running turn; nil when there is none.
    static func underWay(_ stretch: [TurnItem]) -> UnderWay? {
        let work = stretch.filter(\.isWork)
        // The id of the fold the stretch becomes once the agent says something: its first
        // item, which may be a notice or a command's output before the first step.
        guard !work.isEmpty, let first = stretch.first else { return nil }
        // Reasoning ends as soon as anything follows it (`ThreadState`): one still
        // streaming is the turn's latest item.
        var thought: Reasoning?
        var thoughtID: UUID?
        if let last = stretch.last, case let .reasoning(reasoning) = last.content, reasoning.endedAt == nil,
           reasoning.text.contains(where: { !$0.isWhitespace }) {
            thought = reasoning
            thoughtID = last.id
        }
        let hasThought = thought != nil || work.contains { item in
            guard case let .reasoning(reasoning) = item.content else { return false }
            return reasoning.text.contains { !$0.isWhitespace }
        }
        let items = work.filter { item in
            if case .tool = item.content { return true }
            return !item.isInProgress
        }
        return UnderWay(
            id: first.id, items: items, done: work.filter { !$0.isInProgress },
            thought: thought, thoughtID: thoughtID, hasThought: hasThought
        )
    }

    /// From the start of the first step to the end of the last, when each says when it
    /// ran. Steps read back from the host's history do not.
    static func span(of items: [TurnItem]) -> TimeInterval? {
        var start = Date.distantFuture
        var end = Date.distantPast
        for item in items {
            switch item.content {
            case let .tool(run):
                guard let duration = run.duration else { return nil }
                start = min(start, run.startedAt)
                end = max(end, run.startedAt.addingTimeInterval(duration))
            case let .reasoning(reasoning):
                guard let ended = reasoning.endedAt else { return nil }
                start = min(start, reasoning.startedAt)
                end = max(end, ended)
            default:
                continue
            }
        }
        return end > start ? end.timeIntervalSince(start) : nil
    }

    /// "38s", "2m 5s", "1h 4m".
    public static func shortDuration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total < 60 { return "\(total)s" }
        if total < 3_600 {
            let rest = total % 60
            return rest == 0 ? "\(total / 60)m" : "\(total / 60)m \(rest)s"
        }
        let minutes = (total % 3_600) / 60
        return minutes == 0 ? "\(total / 3_600)h" : "\(total / 3_600)h \(minutes)m"
    }

    /// "2.1s" for a tool call: tenths under ten seconds, then `shortDuration`.
    public static func toolDuration(_ seconds: TimeInterval) -> String {
        if seconds < 0.05 { return "0s" }
        if seconds < 9.95 { return String(format: "%.1fs", seconds) }
        return shortDuration(seconds)
    }
}

extension TurnItem {
    public var isUserMessage: Bool {
        if case .user = content { true } else { false }
    }

    public var isEvent: Bool {
        if case .event = content { true } else { false }
    }

    /// What set the turn going: a message, or something the host did. It stays above
    /// the work when the work is folded.
    public var opensTurn: Bool { isUserMessage || isEvent }

    /// Something said in the turn, which stays in view when its work is folded: what
    /// started it, a message sent during it, and the agent's text, its answer and what
    /// it wrote on the way, with the questions it asked in it without waiting
    /// (`RequestRecord.askedAhead`) and how they were answered.
    public var isSaid: Bool {
        if case .text = content { return true }
        if case let .request(record) = content, record.askedAhead == true { return true }
        return opensTurn
    }

    /// Something the agent did on the way to its answer.
    public var isWork: Bool {
        switch content {
        case .tool, .reasoning: true
        case let .request(record): record.askedAhead != true
        case .user, .text, .notice, .command, .event, .compaction: false
        }
    }

    /// The answers given on a card that went to the agent as this message
    /// (`UserMessage.cardAnswer`): their row shows them, and the message is not shown.
    public var isCardAnswer: Bool {
        if case let .user(message) = content { message.cardAnswer != nil } else { false }
    }

    /// A step of the work, as a fold counts and shows them: a tool call or a request.
    var isStep: Bool {
        switch content {
        case .tool, .request: true
        default: false
        }
    }

    /// Work that is still going on: a tool call that has not returned, or reasoning
    /// that is still streaming.
    public var isInProgress: Bool {
        switch content {
        case let .tool(run): run.state == .running
        case let .reasoning(reasoning): reasoning.endedAt == nil
        default: false
        }
    }
}

/// A unified diff, line by line, for display.
public struct DiffText: Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        case added, removed, context, hunk
    }

    public struct Line: Identifiable, Hashable, Sendable {
        public var id: Int
        public var kind: Kind
        /// The line without its `+`, `-` or space marker.
        public var text: String
    }

    /// The changed file's name, from the `+++` line.
    public var fileName: String?
    public var lines: [Line]
    public var added: Int
    public var removed: Int

    public init(_ diff: String) {
        var fileName: String?
        var lines: [Line] = []
        var added = 0
        var removed = 0
        // Lines still to come in the hunk being read, as its header counts them: a removed
        // line that starts with "-- " or an added one with "++ " is not a file's header.
        var oldLeft = 0
        var newLeft = 0
        // Where a `--- `, `+++ ` pair cannot be told from lines removed and added (`guessing`:
        // in a hunk whose header gives no numbers, as an apply_patch's chunk, or among lines
        // with no hunk's header at all, as an edit's old and new text alone), it is a file's
        // header only after git's `diff --git` line, as the bridge reads a turn's diff
        // (`piecesOf`). `header`: the line before was a `--- ` one; `gitLine`: one of git's.
        var guessing = false
        // Right after a file's header: a pair there is the next file's header when a hunk's
        // header, another file's or the end follows it (a file with no hunk, as a rename alone).
        var fresh = false
        var header = false
        var gitLine = false
        let raws = diff.split(separator: "\n", omittingEmptySubsequences: false)
        for (index, raw) in raws.enumerated() {
            let line = String(raw)
            let counted = oldLeft > 0 || newLeft > 0
            let marked = gitLine
            gitLine = false
            let wasFresh = fresh
            fresh = false
            var asHeader = false
            if !counted {
                if line.hasPrefix("--- ") {
                    let next = index + 1 < raws.count ? raws[index + 1] : nil
                    let then = index + 2 < raws.count ? raws[index + 2] : nil
                    let headerNext = then == nil || then?.isEmpty == true || then?.hasPrefix("@@") == true || then?.hasPrefix("--- ") == true
                    asHeader = next?.hasPrefix("+++ ") == true && (marked || (wasFresh ? headerNext : !guessing))
                } else if line.hasPrefix("+++ ") {
                    asHeader = header
                } else if Self.gitHeader(line) {
                    // git's own lines before a file's header say nothing shown here.
                    gitLine = true
                    continue
                }
            }
            header = false
            if asHeader {
                if line.hasPrefix("+++ ") {
                    // The new name wins, unless the file was deleted.
                    if let name = Self.fileName(fromHeader: line.dropFirst(4)) { fileName = name }
                    guessing = false
                    fresh = true
                } else {
                    if fileName == nil { fileName = Self.fileName(fromHeader: line.dropFirst(4)) }
                    header = true
                }
                continue
            }
            if line.hasPrefix("@@") {
                (oldLeft, newLeft) = Self.hunkCounts(line)
                guessing = (oldLeft, newLeft) == (0, 0)
                lines.append(Line(id: lines.count, kind: .hunk, text: line))
                continue
            }
            if line.hasPrefix("\\") { continue } // "\ No newline at end of file"
            if !counted { guessing = true }
            if line.hasPrefix("+") {
                newLeft -= 1
                added += 1
                lines.append(Line(id: lines.count, kind: .added, text: String(line.dropFirst())))
            } else if line.hasPrefix("-") {
                oldLeft -= 1
                removed += 1
                lines.append(Line(id: lines.count, kind: .removed, text: String(line.dropFirst())))
            } else {
                if counted {
                    oldLeft -= 1
                    newLeft -= 1
                }
                lines.append(Line(id: lines.count, kind: .context, text: line.hasPrefix(" ") ? String(line.dropFirst()) : line))
            }
        }
        // A trailing empty context line is the split's artefact, not part of the diff.
        if let last = lines.last, last.kind == .context, last.text.isEmpty { lines.removeLast() }
        self.fileName = fileName
        self.lines = lines
        self.added = added
        self.removed = removed
    }

    /// "+4 −1", or nil when nothing changed.
    public var stats: String? {
        guard added > 0 || removed > 0 else { return nil }
        return ["+\(added)", removed > 0 ? "\u{2212}\(removed)" : nil].compactMap(\.self).joined(separator: " ")
    }

    /// git's lines between `diff --git` and a file's `---` line (as the bridge's `gitHeader`).
    static func gitHeader(_ line: String) -> Bool {
        ["diff --git ", "index ", "new file mode ", "deleted file mode ", "old mode ", "new mode ", "similarity index ", "rename from ", "rename to ", "copy from ", "copy to "].contains { line.hasPrefix($0) }
    }

    /// The old and new line counts a hunk's header gives: "@@ -1,3 +1,4 @@" is (3, 4), a
    /// side without a count is one line; (0, 0) for a header without numbers.
    static func hunkCounts(_ header: String) -> (Int, Int) {
        let parts = header.split(separator: " ")
        guard parts.count >= 3, parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return (0, 0) }
        func count(_ side: Substring) -> Int? {
            let numbers = side.dropFirst().split(separator: ",", omittingEmptySubsequences: false)
            guard let start = numbers.first, let line = Int(start), line >= 0 else { return nil }
            return numbers.count > 1 ? Int(numbers[1]) : 1
        }
        guard let old = count(parts[1]), old >= 0, let new = count(parts[2]), new >= 0 else { return (0, 0) }
        return (old, new)
    }

    private static func fileName(fromHeader header: Substring) -> String? {
        let path = header.split(separator: "\t").first.map(String.init) ?? String(header)
        guard path != "/dev/null" else { return nil }
        let name = (path as NSString).lastPathComponent
        return name.isEmpty ? nil : name
    }
}
