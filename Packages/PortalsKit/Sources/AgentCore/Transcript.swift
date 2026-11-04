import Foundation

/// A thread as the app shows and stores it: an ordered list of turns.
public struct Transcript: Codable, Hashable, Sendable {
    public var turns: [Turn]

    public init(turns: [Turn] = []) {
        self.turns = turns
    }

    public var isEmpty: Bool { turns.isEmpty }

    /// This transcript brought in line with the host's version of the same thread.
    ///
    /// The host's version is the truth about what was said, but it has less detail than
    /// a turn the app watched live (how long each step took, what was approved, the
    /// notices). So the result is the host's turns in the host's order, with each turn
    /// the two agree on taken from here, plus the messages that never reached the host,
    /// which only this copy has.
    ///
    /// - Parameters:
    ///   - authoritative: the host repaired what it had streamed (`ThreadSnapshot.authoritative`):
    ///     its turns replace even those both agree on, keeping only what this app alone
    ///     recorded in them (approvals and answers given here, notices).
    ///   - hostKeepsMessageIDs: the host's messages carry the ids this copy gave them (a copy
    ///     saved here, or a bridge offering `message_ids`), so a message whose delivery was
    ///     never confirmed is the host's only under its own id. A host that does not (Hermes,
    ///     an older bridge) gives each message an id of its own: such a message is then taken
    ///     for the host's next turn with the same words, unless this copy has more turns left
    ///     than the host (it was tried again, and the host saw only that).
    public func merged(withHost host: Transcript, authoritative: Bool = false, hostKeepsMessageIDs: Bool = true) -> Transcript {
        // A message still on its way is set aside: the host's version does not speak
        // for it unless the host has already started on it. It is put back last.
        let hostMessageIDs = Set(host.turns.flatMap(\.items).filter(\.isUserMessage).map(\.id))
        var turns = turns.flatMap { original -> [Turn] in
            // A send can fail after some streamed host output has arrived. Preserve
            // that unconfirmed submission without preserving obsolete host output
            // beside it, especially when a canonical repair replaces the whole run.
            guard original.outcome != .completed, !original.isBeingSent, !original.isUnsent else { return [original] }
            var turn = original
            var attempts: [Turn] = []
            turn.items.removeAll { item in
                guard case let .user(message) = item.content, message.delivery == nil,
                      !hostMessageIDs.contains(item.id) else { return false }
                let failure = TurnFailure(message: "Delivery was not confirmed. Check the thread before trying again.")
                attempts.append(Turn(id: item.id, startedAt: message.sentAt, endedAt: original.endedAt ?? message.sentAt,
                                     outcome: .failed(failure), items: [item]))
                return true
            }
            return attempts + (turn.items.isEmpty ? [] : [turn])
        }
        var sending: Turn?
        if let index = turns.lastIndex(where: { !$0.isLocal }), turns[index].isBeingSent {
            sending = turns.remove(at: index)
        }

        var merged: [Turn] = []
        // The turns kept for agreeing with the host's, with the host's (`takeAskedRows`, once
        // the walk is over).
        var agreed: [(id: Turn.ID, host: Turn)] = []
        // Adds a turn only this copy has. It goes before a turn that is running,
        // which is always the last.
        func keep(_ turn: Turn) {
            if let last = merged.last, last.isRunning {
                merged.insert(turn, at: merged.count - 1)
            } else {
                merged.append(turn)
            }
        }
        // The host's turn the walk has reached.
        var next = 0
        for (index, mine) in turns.enumerated() {
            if mine.isLocal {
                // The host has no part in it: it stays where it is.
                keep(mine)
                continue
            }
            guard next < host.turns.count else {
                // Past the host's end, only what never reached it is kept.
                if mine.isUnsent { keep(mine) }
                else if let commands = mine.commandRecords { keep(commands) }
                continue
            }
            // A failed submission is not evidence that the next host turn is its
            // answer, even when its words or the number of turns happen to match: from a
            // host that keeps this copy's ids, only its own id is. From one that does not,
            // its words are all there is to go by.
            let unconfirmed = mine.isUnsent && mine.items.contains {
                if case let .user(message) = $0.content { message.delivery == nil } else { false }
            }
            let byWords = !unconfirmed || !hostKeepsMessageIDs
            guard let matched = host.turns[next...].firstIndex(where: {
                mine.sharesMessageIdentity(with: $0) || (byWords && mine.userTexts == $0.userTexts)
            }) else {
                if mine.isUnsent { keep(mine) }
                else if let commands = mine.commandRecords { keep(commands) }
                continue
            }
            if unconfirmed, !mine.sharesMessageIdentity(with: host.turns[matched]),
               turns[index...].count(where: { !$0.isLocal }) > host.turns.count - matched {
                // Taken by its words, with more turns left here than there: an attempt the
                // host never saw (it was tried again, and the host has only that).
                keep(mine)
                continue
            }
            merged.append(contentsOf: host.turns[next..<matched])
            next = matched
            let theirs = host.turns[next]
            if !authoritative, !unconfirmed, mine.agrees(with: theirs) {
                var kept = mine
                kept.takeOpeningEvents(from: theirs)
                kept.takeSubagentCalls(from: theirs)
                kept.takeSenders(from: theirs)
                kept.takeCheckpoints(from: theirs)
                // And how a question asked without waiting was settled after the turn (below).
                agreed.append((kept.id, theirs))
                // The host's word on what it spent, unless it has none (a bridge restarted since).
                kept.spent = theirs.spent ?? mine.spent
                // And on what it changed, the same way.
                kept.diff = theirs.diff ?? mine.diff
                kept.failedRequestID = theirs.failedRequestID ?? mine.failedRequestID
                merged.append(kept)
            } else {
                var turn = theirs
                let sameOpener = mine.items.first(where: \.isUserMessage)?.id == theirs.items.first(where: \.isUserMessage)?.id
                    && mine.items.contains(where: \.isUserMessage)
                if mine.userTexts == theirs.userTexts || sameOpener {
                    // The same turn in a newer state: it stays the same turn on screen,
                    // with the images this copy has the files for.
                    turn.id = mine.id
                    turn.startedAt = mine.startedAt
                    turn.keepImages(from: mine)
                    if turn.spent == nil, !turn.isRunning { turn.spent = mine.spent }
                    if turn.diff == nil, !turn.isRunning { turn.diff = mine.diff }
                    // A repair replaces what the host streamed, not what only this app saw.
                    if authoritative { turn.keepAppRecords(from: mine) }
                }
                turn.keepCommandAnswers(from: mine)
                merged.append(turn)
            }
            next += 1
        }
        merged.append(contentsOf: host.turns.dropFirst(next))
        // How a question asked without waiting was settled after its turn, for the turns kept
        // for agreeing. Each question this copy recorded that the merge kept stands for one of
        // the host's rows, which is then not taken (`askedRowsRecordedHere`).
        if !agreed.isEmpty {
            let mine = Set(turns.flatMap(\.items).compactMap { item -> UUID? in
                if case let .request(record) = item.content, record.kind == .question { item.id } else { nil }
            })
            let places = agreed.compactMap { pair in merged.firstIndex(where: { $0.id == pair.id }).map { (index: $0, host: pair.host) } }
            let recordedHere = Self.askedRowsRecordedHere(in: merged, mine: mine, agreed: places)
            for (index, theirs) in places {
                merged[index].takeAskedRows(from: theirs, leaving: recordedHere)
            }
        }
        if let sending {
            // The host's running turn is this message's by its id, or, from a host that keeps
            // no ids, by its words.
            if let index = merged.lastIndex(where: {
                $0.sharesMessageIdentity(with: sending) || (!hostKeepsMessageIDs && $0.isRunning && $0.userTexts == sending.userTexts)
            }) {
                // The host has started on it: its turn is this one, further along.
                merged[index].id = sending.id
                merged[index].startedAt = sending.startedAt
                merged[index].keepImages(from: sending)
            } else {
                merged.append(sending)
            }
        }
        var result = Transcript(turns: merged)
        result.takeToolResults(from: host)
        return result
    }

    /// Only its last `count` turns the host has a part in, and what only this copy has
    /// among and after them: what a page of the host's last turns can speak for
    /// (`ThreadSnapshot.hasEarlier`). The turns before them would otherwise stay as this
    /// copy's own, the app's lines among them piled up at the start.
    public func lastTurns(_ count: Int) -> Transcript {
        guard count > 0 else { return self }
        var seen = 0
        for index in turns.indices.reversed() {
            let turn = turns[index]
            guard !turn.isLocal, !turn.isUnsent, !turn.isBeingSent else { continue }
            seen += 1
            if seen == count { return Transcript(turns: Array(turns[index...])) }
        }
        return self
    }

    /// A tool's id names one row, even if a background receipt was saved before its
    /// final result. The host's latest result wins; only detail absent there stays local.
    ///
    /// An id the host gives more than one row names no one call (some models number calls
    /// afresh in each answer): those rows are a row each, and take the host's results in
    /// order when this copy has as many of them, else stay as they are. Rows with no id
    /// stay as they are.
    private mutating func takeToolResults(from host: Transcript) {
        var hostRuns: [String: [ToolRun]] = [:]
        for turn in host.turns {
            for item in turn.items {
                if case let .tool(run) = item.content { hostRuns[run.id, default: []].append(run) }
            }
        }
        let namesOneCall = { (id: String) in !id.isEmpty && hostRuns[id, default: []].count <= 1 }
        var localRows: [String: Int] = [:]
        var latest: [String: ToolRun] = [:]
        for turn in turns {
            for item in turn.items {
                guard case let .tool(run) = item.content, !run.id.isEmpty else { continue }
                if namesOneCall(run.id) { latest[run.id] = run } else { localRows[run.id, default: 0] += 1 }
            }
        }
        for (id, runs) in hostRuns where namesOneCall(id) { latest[id] = runs.last }
        var seen: Set<String> = []
        var taken: [String: Int] = [:]
        for index in turns.indices {
            turns[index].items = turns[index].items.compactMap { item in
                guard case let .tool(local) = item.content, !local.id.isEmpty else { return item }
                var item = item
                if namesOneCall(local.id) {
                    guard seen.insert(local.id).inserted, let run = latest[local.id] else { return nil }
                    item.content = .tool(Self.toolRun(run, keepingFrom: local))
                } else {
                    let runs = hostRuns[local.id, default: []]
                    guard localRows[local.id] == runs.count else { return item }
                    let position = taken[local.id, default: 0]
                    taken[local.id] = position + 1
                    item.content = .tool(Self.toolRun(runs[position], keepingFrom: local))
                }
                return item
            }
        }
    }

    /// The host's `run` of a call, with what only this app's copy of it knows.
    private static func toolRun(_ host: ToolRun, keepingFrom local: ToolRun) -> ToolRun {
        var run = host
        let sameResult = local.output == run.output && local.state == run.state
        run.startedAt = local.startedAt
        // A history without timing must not attach a launch receipt's duration
        // to a different, final result.
        run.duration = run.duration ?? (sameResult ? local.duration : nil)
        run.label = run.label ?? local.label
        run.input = run.input ?? local.input
        run.diff = run.diff ?? local.diff
        run.path = run.path ?? local.path
        run.plan = run.plan ?? local.plan
        run.execution = run.execution ?? local.execution
        run.subagentCall = local.subagentCall ?? run.subagentCall
        return run
    }

    /// The last thing said into the thread, on one line, for finding it in a list: the
    /// first line with something on it of the last message sent that has anything to
    /// show, at most 140 characters, or "Image" for images alone. A message an agent or
    /// the portals command sent through the host's fleet is shown without the line it
    /// opens with ("[Portals: from Claude Code (thread 6d3c…)]"). Worded as a Portals bridge
    /// words the previews it keeps for every device, so the two agree.
    public var preview: String? {
        for turn in turns.reversed() {
            for item in turn.items.reversed() {
                guard case let .user(message) = item.content, let preview = message.preview else { continue }
                return preview
            }
        }
        return nil
    }
}

extension UserMessage {
    /// The message on one line (`Transcript.preview`); nil when it has nothing to show.
    var preview: String? {
        let shown = relayed?.text ?? text
        let line = shown.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if let line { return String(line.prefix(140)) }
        if !images.isEmpty, !files.isEmpty { return "\(images.count + files.count) attachments" }
        if let file = files.first { return files.count == 1 ? file.filename : "\(files.count) files" }
        guard !images.isEmpty else { return nil }
        return images.count == 1 ? "Image" : "\(images.count) images"
    }
}

/// One run of the agent and everything that happened in it.
///
/// A turn usually opens with the message that started it, but need not: the agent can
/// start one itself (a background job finishing), and a message sent mid-run joins the
/// turn that is already going.
extension Transcript {
    /// The host's rows of questions asked without waiting, in the turns kept for agreeing
    /// (`agreed`: each turn's place in `merged` and the host's copy of it), that this copy
    /// records already: answered or closed here, under the card's own id, not the row's (the
    /// tool call's). Nothing names the one by the other, so each of this copy's records the
    /// merge kept (`mine`, in any turn: a question answered here can be recorded in a later
    /// turn than the one that asked it) is matched, in order, to one row of the same words:
    /// one asked in its turn or before it rather than after; of those, one with the same
    /// answer; then the one nearest its turn. So two questions of identical wording, one
    /// recorded here and one not, are told apart by their answers and their turns, where
    /// counting by words alone took the first row (recent-20 (a)).
    static func askedRowsRecordedHere(in merged: [Turn], mine: Set<UUID>, agreed: [(index: Int, host: Turn)]) -> Set<UUID> {
        var rows: [(turn: Int, id: UUID, record: RequestRecord)] = []
        for (index, host) in agreed {
            for item in host.items {
                if case let .request(record) = item.content, record.kind == .question, record.askedAhead == true {
                    rows.append((index, item.id, record))
                }
            }
        }
        var taken = Set<Int>()
        for (index, turn) in merged.enumerated() {
            for item in turn.items where mine.contains(item.id) {
                guard case let .request(record) = item.content else { continue }
                var best: (row: Int, score: (Int, Int, Int))?
                for (row, candidate) in rows.enumerated() where !taken.contains(row) && candidate.record.prompt == record.prompt {
                    let notLater = candidate.turn <= index
                    let score = (notLater ? 1 : 0, candidate.record.answer == record.answer ? 1 : 0, notLater ? candidate.turn : -candidate.turn)
                    if best == nil || score > best!.score { best = (row, score) }
                }
                if let best { taken.insert(best.row) }
            }
        }
        return Set(taken.map { rows[$0].id })
    }
}

public struct Turn: Identifiable, Codable, Hashable, Sendable {
    public var id: UUID
    public var startedAt: Date
    public var endedAt: Date?
    /// nil while the turn is running.
    public var outcome: TurnOutcome?
    public var items: [TurnItem]
    /// What the turn spent, as the host told it once it ended; nil from a host that does
    /// not say, or before it ended.
    public var spent: TurnSpent?
    /// What the turn changed, as the host told it once it ended; nil from a host that
    /// does not say, for a turn that changed no file, or before it ended.
    public var diff: TurnDiff?
    /// The host's exact failed request, which a late acceptance may replace.
    public var failedRequestID: String?

    public init(id: UUID = UUID(), startedAt: Date = .now, endedAt: Date? = nil, outcome: TurnOutcome? = nil, items: [TurnItem] = [], spent: TurnSpent? = nil, diff: TurnDiff? = nil) {
        self.id = id
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.outcome = outcome
        self.items = items
        self.spent = spent
        self.diff = diff
    }

    public var isRunning: Bool { outcome == nil }

    /// What the user said in this turn, in order.
    var userTexts: [String] {
        items.compactMap { item in
            if case let .user(message) = item.content { message.text } else { nil }
        }
    }

    /// The UUID sent as `message_id` is the persisted user item's own id. Never
    /// infer delivery of an unconfirmed submission from its words.
    func sharesMessageIdentity(with other: Turn) -> Bool {
        let mine = Set(items.filter(\.isUserMessage).map(\.id))
        return other.items.contains { $0.isUserMessage && mine.contains($0.id) }
    }

    /// Takes the host's word (`other`, its copy of this turn) on who sent this turn's
    /// messages through the fleet (`senders`), message by message in order, where it says:
    /// a copy saved before the app read it, or watched while the host did not say, has
    /// none, and would show the Mac by its own name rather than the app's for it.
    mutating func takeSenders(from other: Turn) {
        let theirs = other.items.compactMap { item -> UserMessage? in
            if case let .user(message) = item.content { message } else { nil }
        }
        var next = 0
        for index in items.indices {
            guard case var .user(message) = items[index].content else { continue }
            defer { next += 1 }
            guard next < theirs.count, let from = theirs[next].from, from != message.from,
                  theirs[next].text == message.text else { continue }
            message.from = from
            items[index].content = .user(message)
        }
    }

    /// The host's latest checkpoint belongs to the opening message, never a steer.
    mutating func takeCheckpoints(from other: Turn) {
        guard let mine = items.firstIndex(where: \.isUserMessage),
              let theirs = other.items.first(where: \.isUserMessage),
              case var .user(message) = items[mine].content,
              case let .user(host) = theirs.content,
              message.text == host.text else { return }
        message.checkpoint = host.checkpoint
        items[mine].content = .user(message)
    }

    /// Takes the images of `other`'s messages for this turn's messages, in order. The
    /// host's history only names images; the copy made when they were sent has them.
    mutating func keepImages(from other: Turn) {
        let sent = other.items.compactMap { item -> UserMessage? in
            if case let .user(message) = item.content { message } else { nil }
        }
        var next = 0
        for index in items.indices {
            guard case var .user(message) = items[index].content else { continue }
            defer { next += 1 }
            guard next < sent.count else { continue }
            if !sent[next].images.isEmpty { message.images = sent[next].images }
            // The copy that sent them knows their sizes; the host's, where it saved them.
            if !sent[next].files.isEmpty {
                let host = message.files
                message.files = sent[next].files.enumerated().map { offset, local in
                    var file = local
                    if file.path == nil, offset < host.count { file.path = host[offset].path }
                    return file
                }
            }
            items[index].content = .user(message)
        }
    }

    /// Puts back what only this app recorded in `other`, its own copy of this turn, after
    /// the host's version replaced it: the approvals and answers given here, and notices.
    /// Each goes before the first item after it that this turn has too (a tool by its id,
    /// a message or a reply by its words), else at the end. A question the host's turn
    /// records already (a `clarify` call) is not put back twice.
    mutating func keepAppRecords(from other: Turn) {
        let hostAsks = items.contains { if case let .request(record) = $0.content { record.kind == .question } else { false } }
        func isAppRecord(_ item: TurnItem) -> Bool {
            switch item.content {
            case let .request(record): !(record.kind == .question && hostAsks)
            case .notice: true
            default: false
            }
        }
        let have = Set(items.map(\.id))
        place(other.items.filter { isAppRecord($0) && !have.contains($0.id) }, asIn: other)
    }

    /// Takes the host's rows of questions asked without waiting that this copy of the turn,
    /// kept for agreeing with the host's (`Transcript.merged`), has no record of: one
    /// settled after the turn, while this app was away (answered elsewhere, or taken back),
    /// where the card this app had open stood for it. The rows `recordedHere` are questions
    /// this copy records already (`Transcript.askedRowsRecordedHere`), which keep their record.
    mutating func takeAskedRows(from host: Turn, leaving recordedHere: Set<UUID>) {
        let rows = host.items.filter { item in
            guard case let .request(record) = item.content, record.kind == .question, record.askedAhead == true else { return false }
            return !recordedHere.contains(item.id)
        }
        place(rows, asIn: host)
    }

    /// Puts `records`, items of `other` (another copy of this turn) this turn does not have,
    /// in it: each before the first item after it in `other` that this turn has too (a tool
    /// by its id, a message or a reply by its words), else at the end.
    private mutating func place(_ records: [TurnItem], asIn other: Turn) {
        guard !records.isEmpty else { return }
        func key(_ item: TurnItem) -> String? {
            switch item.content {
            case let .tool(run): "tool:\(run.id)"
            case let .text(text): "text:\(text.trimmingCharacters(in: .whitespacesAndNewlines))"
            case let .user(message): "user:\(message.text)"
            default: nil
            }
        }
        let placing = Set(records.map(\.id))
        // Where each goes: before the first item after it in `other` that this turn has.
        let theirs = Set(items.compactMap(key))
        var before: [String: [TurnItem]] = [:]
        var waiting: [TurnItem] = []
        for item in other.items {
            if placing.contains(item.id) {
                waiting.append(item)
            } else if !waiting.isEmpty, let anchor = key(item), theirs.contains(anchor) {
                before[anchor, default: []].append(contentsOf: waiting)
                waiting = []
            }
        }
        var rebuilt: [TurnItem] = []
        rebuilt.reserveCapacity(items.count + records.count)
        for item in items {
            if let anchor = key(item), let placed = before.removeValue(forKey: anchor) { rebuilt.append(contentsOf: placed) }
            rebuilt.append(item)
        }
        items = rebuilt + waiting
    }

    /// Takes the host's word on what set this turn going. A turn watched live starts
    /// with no word of why, or with the short one the host gave at the time.
    mutating func takeOpeningEvents(from other: Turn) {
        let theirs = other.items.prefix(while: \.isEvent)
        guard !theirs.isEmpty else { return }
        let mine = items.prefix(while: \.isEvent).count
        if mine == theirs.count {
            // The same lines, reworded: they stay the same lines on screen.
            for (index, event) in theirs.enumerated() { items[index].content = event.content }
        } else {
            items.replaceSubrange(..<mine, with: theirs)
        }
    }

    /// Takes the host's word on who this turn's calls about the agents it set to work were
    /// about (`SubagentCall`), by the call's id, where this copy does not say: one saved
    /// before the app showed such a call as a line of its own, or watched while the host
    /// could not name them. A copy that names them keeps its own names, and its times.
    mutating func takeSubagentCalls(from other: Turn) {
        var theirs: [String: ToolRun] = [:]
        for item in other.items {
            if case let .tool(run) = item.content, run.subagentCall != nil { theirs[run.id] = run }
        }
        guard !theirs.isEmpty else { return }
        for index in items.indices {
            guard case var .tool(run) = items[index].content, let host = theirs[run.id], let call = host.subagentCall else { continue }
            guard run.subagentCall == nil || (run.subagentCall?.agents.isEmpty == true && !call.agents.isEmpty) else { continue }
            run.subagentCall = call
            run.label = host.label
            run.input = host.input
            run.output = host.output
            items[index].content = .tool(run)
        }
    }

    /// The last piece of reply text.
    var lastText: String? {
        items.reversed().lazy.compactMap { item -> String? in
            if case let .text(text) = item.content { text } else { nil }
        }.first
    }

    /// A turn that failed before the agent did anything: the message may never have
    /// reached the host.
    var isUnsent: Bool {
        guard case .failed = outcome else { return false }
        return items.allSatisfy { item in
            switch item.content {
            case .user, .notice: true
            default: false
            }
        }
    }

    /// A turn opened by a message the backend has not answered for yet. The host may
    /// not know it exists.
    var isBeingSent: Bool {
        guard isRunning, !items.isEmpty else { return false }
        return items.allSatisfy { item in
            if case let .user(message) = item.content { message.delivery == nil } else { false }
        }
    }

    /// A turn the host has no part in: nothing but the app's own lines (a command's
    /// answer, a notice), with no message and no reply. The host's history never has it.
    var isLocal: Bool {
        guard outcome == .completed, !items.isEmpty else { return false }
        return items.allSatisfy { item in
            switch item.content {
            case .command, .notice: true
            default: false
            }
        }
    }

    /// Whether this copy of a turn can stand for the host's: both are over and were
    /// started by the same messages, with no final reply on the host that this copy
    /// lacks. A reconnect may have split even a completed turn in this copy.
    func agrees(with host: Turn) -> Bool {
        guard !isRunning, !host.isRunning, userTexts == host.userTexts else { return false }
        let reply = host.lastText?.trimmingCharacters(in: .whitespacesAndNewlines)
        return reply == nil || reply == lastText?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public struct TurnItem: Identifiable, Codable, Hashable, Sendable {
    public enum Content: Codable, Hashable, Sendable {
        case user(UserMessage)
        /// The agent's reply text, as Markdown.
        case text(String)
        /// The model thinking out loud before it acts or answers.
        case reasoning(Reasoning)
        case tool(ToolRun)
        /// An approval or a question, and how it was answered.
        case request(RequestRecord)
        case notice(Notice)
        /// A slash command the host ran, and its answer.
        case command(CommandRun)
        /// What the host did by itself that set the agent going, where a turn the user
        /// started has their message.
        case event(HostEvent)
        /// Where the agent summarised the conversation so far to free its context.
        case compaction(Compaction)
    }

    public var id: UUID
    public var content: Content

    public init(id: UUID = UUID(), _ content: Content) {
        self.id = id
        self.content = content
    }
}

public struct UserMessage: Codable, Hashable, Sendable {
    public var text: String
    public var sentAt: Date
    /// What the backend did with it; nil until it answers.
    public var delivery: SendOutcome?
    /// The images sent with it.
    public var images: [AttachedImage]
    /// The files sent with it (a Portals bridge's `files`).
    public var files: [AttachedFile]
    /// Who sent it through the host's fleet, as the host says (`senders`); nil for a
    /// message of the user's, and from a host that does not say (`relayed` reads its line).
    public var from: MessageSender?
    /// The answers the user gave on the card of questions asked without waiting (a
    /// bridge's `async_questions`), which went to the agent as this message: the id of
    /// the questions' row, which shows them. The message has no bubble of its own
    /// (`TurnLayout`). nil for any other.
    public var cardAnswer: String?
    /// Provider-native position of this turn's opener, distinct from the user item's id.
    public var checkpoint: MessageCheckpoint?

    public init(
        text: String, sentAt: Date = .now, delivery: SendOutcome? = nil, images: [AttachedImage] = [], files: [AttachedFile] = [], from: MessageSender? = nil,
        cardAnswer: String? = nil, checkpoint: MessageCheckpoint? = nil
    ) {
        self.text = text
        self.sentAt = sentAt
        self.delivery = delivery
        self.images = images
        self.files = files
        self.from = from
        self.cardAnswer = cardAnswer
        self.checkpoint = checkpoint
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decode(String.self, forKey: .text)
        sentAt = try container.decode(Date.self, forKey: .sentAt)
        delivery = try container.decodeIfPresent(SendOutcome.self, forKey: .delivery)
        // Transcripts saved before images or files could be sent have none.
        images = try container.decodeIfPresent([AttachedImage].self, forKey: .images) ?? []
        files = try container.decodeIfPresent([AttachedFile].self, forKey: .files) ?? []
        from = try container.decodeIfPresent(MessageSender.self, forKey: .from)
        cardAnswer = try container.decodeIfPresent(String.self, forKey: .cardAnswer)
        checkpoint = try container.decodeIfPresent(MessageCheckpoint.self, forKey: .checkpoint)
    }
}

/// Something the host did by itself that starts a turn: a background process or other
/// agents finished, a recurring task came due, a turn cut short was picked up again.
/// The host tells the model about it in a long message written for the model; the
/// reader gets one line.
public struct HostEvent: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Hashable, Sendable {
        case backgroundProcess, backgroundAgents, recurringTask, resumed, other
    }

    public var kind: Kind
    /// One line saying what happened.
    public var text: String

    public init(_ kind: Kind, _ text: String) {
        self.kind = kind
        self.text = text
    }
}

/// A slash command the host ran outside the conversation, and what it answered, or one
/// that did not run at all. The app's alone: the agent never saw it and the host's
/// history does not have it.
public struct CommandRun: Codable, Hashable, Sendable {
    /// As it was run: "/status".
    public var command: String
    public var output: String
    /// Why the command did not run, when it did not: the host refused it, did not know
    /// it, or could not be asked. Saved transcripts from before have none.
    public var failure: String?

    public init(command: String, output: String, failure: String? = nil) {
        self.command = command
        self.output = output
        self.failure = failure
    }
}

/// Where the agent summarised the conversation so far, to free its context for what
/// comes next: asked for with `/compact`, or by itself as the context filled up.
public struct Compaction: Codable, Hashable, Sendable {
    public enum Trigger: String, Codable, Hashable, Sendable {
        /// Asked for (`/compact`).
        case manual
        /// The agent did it by itself, as the context filled up.
        case auto
    }

    public var trigger: Trigger
    /// How many tokens the context held before, when the host said.
    public var tokensBefore: Int?

    public init(_ trigger: Trigger, tokensBefore: Int? = nil) {
        self.trigger = trigger
        self.tokensBefore = tokensBefore
    }

    /// One line saying what happened: "Conversation compacted · 24k tokens before".
    public var summary: String {
        let what = trigger == .auto ? "Conversation compacted automatically" : "Conversation compacted"
        guard let tokensBefore, tokensBefore > 0 else { return what }
        return "\(what) · \(Self.tokens(tokensBefore)) tokens before"
    }

    /// A token count as people say it: "950", "2.8k", "24k", "1.2M".
    static func tokens(_ count: Int) -> String {
        func short(_ value: Double, _ unit: String) -> String {
            // One decimal under ten, where it says something; none above.
            let rounded = value < 9.95 ? (value * 10).rounded() / 10 : value.rounded()
            let text = rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
            return text + unit
        }
        if count < 1_000 { return String(count) }
        if count < 999_500 { return short(Double(count) / 1_000, "k") }
        return short(Double(count) / 1_000_000, "M")
    }
}

/// One call the agent made to a tool: a command, a file read, an edit.
public struct ToolRun: Identifiable, Codable, Hashable, Sendable {
    public enum State: String, Codable, Hashable, Sendable {
        case running, succeeded, failed
    }

    /// The backend's id for the call.
    public var id: String
    /// The tool's name as the backend knows it ("terminal", "read_file").
    public var name: String
    /// One line saying what it is doing: the command, the file.
    public var label: String?
    /// What it was called with, as text.
    public var input: String?
    /// What it returned, as text.
    public var output: String?
    /// The change it made, as a unified diff.
    public var diff: String?
    public var state: State
    public var startedAt: Date
    public var duration: TimeInterval?
    /// A call about the agents the agent set to work, which the row says in words in
    /// place of the tool's name and label ("Waited for Darwin and Euclid").
    public var subagentCall: SubagentCall?
    /// The file a read, a write or an edit is about, as the agent named it (the label
    /// has its name only): what the row's Open File opens (`FileReading`).
    public var path: String?
    /// The line a read of part of the file began at (its `offset`): where Open File opens it.
    public var startLine: Int?
    public var plan: TodoPlan?
    public var progress: String?
    public var outputTruncated: Bool?
    public var execution: ToolExecution?

    public init(
        id: String,
        name: String,
        label: String? = nil,
        input: String? = nil,
        output: String? = nil,
        diff: String? = nil,
        state: State = .running,
        startedAt: Date = .now,
        duration: TimeInterval? = nil,
        subagentCall: SubagentCall? = nil,
        path: String? = nil,
        startLine: Int? = nil,
        plan: TodoPlan? = nil,
        progress: String? = nil,
        outputTruncated: Bool? = nil,
        execution: ToolExecution? = nil
    ) {
        self.id = id
        self.name = name
        self.label = label
        self.input = input
        self.output = output
        self.diff = diff
        self.state = state
        self.startedAt = startedAt
        self.duration = duration
        self.subagentCall = subagentCall
        self.path = path
        self.startLine = startLine
        self.plan = plan
        self.progress = progress
        self.outputTruncated = outputTruncated
        self.execution = execution
    }
}

/// How a tool call ended.
public struct ToolResult: Hashable, Sendable {
    public var id: String
    /// `name`, `label` and `input` repeat what the start said, so a result whose start
    /// was missed (the app reconnected in between) can still be shown in full.
    public var name: String
    public var label: String?
    public var input: String?
    public var succeeded: Bool
    public var duration: TimeInterval?
    public var output: String?
    public var diff: String?
    /// The call about the agents the agent set to work, as it ended: a wait comes to name
    /// those that ended while it waited.
    public var subagentCall: SubagentCall?
    /// The file the call is about (`ToolRun.path`).
    public var path: String?
    /// Where a read of part of it began (`ToolRun.startLine`).
    public var startLine: Int?
    public var plan: TodoPlan?
    public var execution: ToolExecution?

    public init(
        id: String,
        name: String,
        label: String? = nil,
        input: String? = nil,
        succeeded: Bool,
        duration: TimeInterval? = nil,
        output: String? = nil,
        diff: String? = nil,
        subagentCall: SubagentCall? = nil,
        path: String? = nil,
        startLine: Int? = nil,
        plan: TodoPlan? = nil,
        execution: ToolExecution? = nil
    ) {
        self.path = path
        self.startLine = startLine
        self.plan = plan
        self.execution = execution
        self.id = id
        self.name = name
        self.label = label
        self.input = input
        self.succeeded = succeeded
        self.duration = duration
        self.output = output
        self.diff = diff
        self.subagentCall = subagentCall
    }
}

/// A stretch of the model's reasoning.
public struct Reasoning: Codable, Hashable, Sendable {
    public var text: String
    public var startedAt: Date
    /// nil while the model is still reasoning.
    public var endedAt: Date?

    public init(text: String, startedAt: Date = .now, endedAt: Date? = nil) {
        self.text = text
        self.startedAt = startedAt
        self.endedAt = endedAt
    }

    public var duration: TimeInterval? {
        endedAt.map { $0.timeIntervalSince(startedAt) }
    }
}

/// What the backend did with a message.
public enum SendOutcome: String, Codable, Hashable, Sendable {
    /// It started a turn.
    case started
    /// The agent was busy; the message runs after the current turn.
    case queued
    /// The agent was busy; the message was injected into the current turn as guidance.
    case steered
    /// The agent was busy; the current turn was redirected to this message.
    case redirected
}

/// A line the backend wants the reader to see, outside the reply itself.
public struct Notice: Codable, Hashable, Sendable {
    public enum Level: String, Codable, Hashable, Sendable {
        case info, warning, error
    }

    public var level: Level
    public var text: String

    public init(_ level: Level, _ text: String) {
        self.level = level
        self.text = text
    }
}

public enum TurnOutcome: Codable, Hashable, Sendable {
    case completed
    /// Stopped by the user or by the backend.
    case interrupted
    case failed(TurnFailure)
}

public struct TurnFailure: Codable, Hashable, Sendable {
    /// Words that are safe to show.
    public var message: String
    /// The underlying error, when the backend gave one.
    public var detail: String?
    public var retryable: Bool

    public init(message: String, detail: String? = nil, retryable: Bool = true) {
        self.message = message
        self.detail = detail
        self.retryable = retryable
    }
}
