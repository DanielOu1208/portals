import Foundation

/// Threads whose turn ended on this device out of sight, on a host that keeps the list
/// and marks such a thread unseen for every device itself. Until the host's list says
/// so too, the thread would be neither running nor unseen, and under no group of the
/// sidebar for a moment: it is counted as unseen here at once instead.
///
/// The mark is only in what the sidebar shows (`applied`): it is never written into the
/// list, where the host's next list would undo it and the dot blink, nor sent, which
/// would mark the thread unseen again on a device that has already looked at it. It
/// goes once the host's list has the thread changed since the turn ended (it says then,
/// unseen or seen), once the thread is opened, or after `lifetime` when no list comes.
///
/// A thread opened while it is unseen only by this mark is read here before the host's
/// list has the turn's end: a seen sent now would go with the revision listed here,
/// from before the end, and the host would keep the turn unseen. It is kept as read
/// (`readHere`) until the host's list has the thread changed since, and the merge that
/// brings the end takes it as seen, as it does the thread looked at. With the turn read,
/// as the list here had it: that merge may bring a later turn too, from another device,
/// which the turn read does not clear, here or on the host.
/// What a thread read here before the host's list had its turn's end knows of the turn
/// read, for the merge that brings the end to tell it from a later turn another device ran
/// meanwhile (net-20).
public struct TurnRead: Hashable, Sendable {
    /// The thread's latest turn as the list here had it when the turn ended
    /// (`ThreadRecord.turn`); nil when it did not say.
    public var turn: Int?
    /// Where the host said its list was (`sessions.activity`) last before the thread was
    /// read, when it did not say the thread was at work then: a turn that began by then
    /// had ended by the read. nil when unknown, or at work.
    public var heard: ThreadListRevision?

    public init(turn: Int? = nil, heard: ThreadListRevision? = nil) {
        self.turn = turn
        self.heard = heard
    }

    /// Whether the thread's latest turn as listed, begun at `latest` in the list `list`, is
    /// one read here: the one the list here had when the turn ended, or one begun (and so
    /// ended) by the time the host was last heard before the read. A turn the list here
    /// missed the start of, quick, is then the one read; a later one is not.
    public func covers(_ latest: Int, in list: String) -> Bool {
        if latest == turn { return true }
        guard let heard, heard.id == list else { return false }
        return latest <= heard.revision
    }
}

public struct EndedOutOfSight: Sendable, Equatable {
    private struct Ended: Sendable, Equatable {
        /// The thread's revision in the host's list when the turn ended; nil for one not
        /// listed by the host yet.
        var revision: Int?
        /// The turn that ended, as the host's list had it then (`ThreadRecord.turn`).
        var turn: Int?
        /// Once read: where the host's list was last heard to be before (`TurnRead.heard`).
        var heard: ThreadListRevision?
        var at: Date

        /// Whether the host's list, at `listed`, has the thread changed since.
        func isOvertaken(by listed: Int) -> Bool {
            revision.map { listed > $0 } ?? true
        }
    }

    /// How long a mark stays when the host's list does not come.
    public static let lifetime: TimeInterval = 30

    private var ended: [ThreadRef.ID: Ended] = [:]
    private var read: [ThreadRef.ID: Ended] = [:]

    public init() {}

    public var isEmpty: Bool { ended.isEmpty && read.isEmpty }

    /// The threads read here whose turn's end the host's list does not have yet, each with
    /// what is known of the turn read.
    public var readHere: [ThreadRef.ID: TurnRead] { read.mapValues { TurnRead(turn: $0.turn, heard: $0.heard) } }

    /// The turn of `thread` ended here, out of sight, `at` then. `turn`: the turn that
    /// ended as the host said with its end (`ThreadEvent.turnListed`), which a quick turn
    /// the list here never had is known by; else the list's latest here.
    public mutating func turnEnded(_ thread: ThreadRecord, turn: Int? = nil, at: Date = .now) {
        ended[thread.id] = Ended(revision: thread.revision, turn: turn ?? thread.turn, at: at)
        read[thread.id] = nil
    }

    /// The thread was looked at: whatever finished in it is seen, and one unseen only by
    /// its mark is read here until the host's list has its turn's end. `heard`: where the
    /// host last said its list was, when it did not say the thread was at work then
    /// (`TurnRead.heard`).
    public mutating func seen(_ id: ThreadRef.ID, heard: ThreadListRevision? = nil) {
        guard var mark = ended.removeValue(forKey: id) else { return }
        mark.heard = heard
        read[id] = mark
    }

    /// The list as it is now, after a merge: a thread the host has listed changed since
    /// its turn ended is the host's to say about.
    public mutating func listed(_ threads: [ThreadRecord]) {
        guard !isEmpty else { return }
        for record in threads {
            guard let revision = record.revision else { continue }
            if ended[record.id]?.isOvertaken(by: revision) == true { ended[record.id] = nil }
            if read[record.id]?.isOvertaken(by: revision) == true { read[record.id] = nil }
        }
    }

    /// Lets go of the marks older than `lifetime`.
    public mutating func expire(now: Date = .now) {
        ended = ended.filter { now.timeIntervalSince($0.value.at) < Self.lifetime }
        read = read.filter { now.timeIntervalSince($0.value.at) < Self.lifetime }
    }

    /// The threads as the sidebar shows them: each ended here out of sight is unseen.
    public func applied(to threads: [ThreadRecord], now: Date = .now) -> [ThreadRecord] {
        guard !ended.isEmpty else { return threads }
        return threads.map { record in
            guard !record.isUnseen, let mark = ended[record.id], now.timeIntervalSince(mark.at) < Self.lifetime else { return record }
            var shown = record
            shown.unseen = true
            return shown
        }
    }
}
