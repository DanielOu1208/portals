import Foundation

// The list of threads a host keeps for every device (a Portals bridge's
// `thread_sync`, docs/sync-plan.md): what the app reads of it, what it sends, and how an
// answer is merged into the threads a device holds for that host.

/// Which list a host keeps, and how far it has got: the list's id, and its revision,
/// which goes up with every change a listing shows.
public struct ThreadListRevision: Codable, Hashable, Sendable {
    public var id: String
    public var revision: Int

    public init(id: String, revision: Int) {
        self.id = id
        self.revision = revision
    }
}

/// Who started a thread, when an agent did, through the host's fleet: "Claude Code",
/// "Claude Code on mini", "the portals command" (and "Aeri", on a bridge from before
/// 2026-10-21). A thread a person started from a device has none.
public struct ThreadStarter: Codable, Hashable, Sendable {
    public var name: String
    /// The thread it was started from, when that is one of the host's.
    public var thread: ThreadRef.ID?
    /// Who started it as facts, from a host that says (`senders`): with `machine`, a
    /// thread of another Mac, which the app may know as another of its hosts.
    public var from: MessageSender?

    public init(name: String, from: MessageSender? = nil, thread: ThreadRef.ID? = nil) {
        self.name = name
        self.from = from
        self.thread = thread
    }

    /// What a thread's row says of it: "Started by Claude Code", "Started by Codex on
    /// Mac mini": another Mac by `macName` (the app's name for the host it knows by that
    /// id) when it does, else as the host words it.
    public func caption(macName: (String) -> String? = { _ in nil }) -> String {
        guard let from, from.isFromAnotherMac, let mac = from.machine.flatMap(macName) else { return "Started by \(name)" }
        return "Started by \(from.isCommandLine ? "the portals command" : (from.agentName ?? from.agent ?? "an agent")) on \(mac)"
    }

    /// What a thread's row says of it, each Mac as the host names it.
    public var caption: String { caption() }
}

/// A thread as the host's list gives it.
public struct ListedThread: Hashable, Sendable {
    public var id: ThreadRef.ID
    /// The agent's name on the host (its profile).
    public var agent: String
    public var title: String?
    /// The folder the agent works in, as its real path on the host.
    public var folder: String?
    public var readOnly: Bool
    /// Its agent's one ongoing conversation (`ThreadRef.ongoing`).
    public var ongoing: Bool
    public var created: Date?
    /// When a turn last started or ended in it: its place in every device's list.
    public var updated: Date
    /// The list's revision when the thread last changed.
    public var revision: Int
    /// Which turn is the thread's latest: the list's revision when it began. nil from a
    /// bridge from before 2026-10-26, and for a thread with none recorded since.
    public var turn: Int?
    public var preview: String?
    public var pinned: Bool
    public var archived: Bool
    public var unseen: Bool
    public var startedBy: ThreadStarter?
    /// Shown in the sidebar too, though an agent started it from another thread.
    public var shared: Bool
    /// Under Recent on every device (a bridge's `recent_threads`).
    public var recent: Bool
    /// The git branch checked out in its folder as a turn last started or ended there.
    public var branch: String?
    /// For a thread whose folder is in a git worktree: the folder of the repository's
    /// main checkout it is listed under, its project (a bridge's `worktrees`).
    public var repo: String?

    public init(
        id: ThreadRef.ID, agent: String, title: String? = nil, folder: String? = nil, readOnly: Bool = false, ongoing: Bool = false,
        created: Date? = nil, updated: Date, revision: Int, preview: String? = nil,
        pinned: Bool = false, archived: Bool = false, unseen: Bool = false, startedBy: ThreadStarter? = nil, shared: Bool = false,
        branch: String? = nil, repo: String? = nil, turn: Int? = nil, recent: Bool = false
    ) {
        self.id = id
        self.recent = recent
        self.agent = agent
        self.turn = turn
        self.title = title
        self.folder = folder
        self.readOnly = readOnly
        self.ongoing = ongoing
        self.created = created
        self.updated = updated
        self.revision = revision
        self.preview = preview
        self.pinned = pinned
        self.archived = archived
        self.unseen = unseen
        self.startedBy = startedBy
        self.shared = shared
        self.branch = branch
        self.repo = repo
    }
}

/// What a host's list changed since a revision of it: the threads changed and the ids
/// taken off it since then. A full answer (`isFull`) has every thread, and every id ever
/// taken off and not taken up again, for a device that held another list or none.
public struct ThreadListChanges: Hashable, Sendable {
    public var list: ThreadListRevision
    public var threads: [ListedThread]
    public var removed: [ThreadRef.ID]
    public var isFull: Bool
    /// Threads the host listed whose entry could not be read: neither changed nor
    /// forgotten here.
    public var unreadable: [ThreadRef.ID]

    public init(
        list: ThreadListRevision, threads: [ListedThread] = [], removed: [ThreadRef.ID] = [], isFull: Bool = false,
        unreadable: [ThreadRef.ID] = []
    ) {
        self.list = list
        self.threads = threads
        self.removed = removed
        self.isFull = isFull
        self.unreadable = unreadable
    }
}

/// Marks to set on one of the host's threads. Only those given change.
public struct ThreadMarks: Hashable, Sendable {
    public var pinned: Bool?
    /// Archiving unpins, on the host as here.
    public var archived: Bool?
    public var unseen: Bool?
    /// With `unseen: false`: the thread's revision as this device last listed it, so the
    /// seen does not clear a turn that ended after that.
    public var revision: Int?
    /// With `revision`: the list it is a revision of. A seen listed under another list (a
    /// bridge home before this one) says nothing of the host's, which ignores it.
    public var list: String?
    /// With `unseen: false`: the turn the seen is of, as listed (`ListedThread.turn`), for
    /// a turn read here before the list had its end: the host ignores the seen when its
    /// latest turn is another, so it never clears a later one.
    public var turn: Int?
    /// Taken only by a thread the host has no preview for.
    public var preview: String?
    /// Shows a thread an agent started in the sidebar too, or puts it back under the
    /// thread that started it (`agent_threads`).
    public var shared: Bool?
    /// Puts the thread under Recent on every device, or takes it out (`recent_threads`).
    public var recent: Bool?

    public init(
        pinned: Bool? = nil, archived: Bool? = nil, unseen: Bool? = nil, revision: Int? = nil, list: String? = nil,
        turn: Int? = nil, preview: String? = nil, shared: Bool? = nil, recent: Bool? = nil
    ) {
        self.turn = turn
        self.recent = recent
        self.pinned = pinned
        self.archived = archived
        self.unseen = unseen
        self.revision = revision
        self.list = list
        self.preview = preview
        self.shared = shared
    }
}

public enum ThreadSyncError: LocalizedError, Hashable, Sendable {
    /// The host does not keep the list (an older bridge, Hermes): nothing was sent.
    case unavailable
    /// The host has no such thread.
    case unknownThread
    /// The host would not do it, or could not, and says why in a sentence for the user.
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This host does not keep a list of threads for every device."
        case .unknownThread: "This thread is no longer on the host."
        case let .refused(reason): reason
        }
    }
}

/// A host that keeps the list of its threads for every device (a Portals bridge's
/// `thread_sync`): which threads exist, their titles, pins, archive and unseen marks.
/// Elsewhere the list is the device's own. Each call throws `ThreadSyncError.unavailable`,
/// sending nothing, to a host that does not keep the list.
public protocol ThreadSyncing: Sendable {
    /// Whether the host keeps the list, as of the last connection; nil before the first.
    var syncsThreads: Bool? { get async }
    /// What changed in the host's list since `since`; every thread when `since` is nil
    /// or not a revision of the list the host keeps now.
    func threadListChanges(since: ThreadListRevision?) async throws -> ThreadListChanges
    /// Sets marks on one of the host's threads for every device, and gives the thread as
    /// the host lists it after them, or nil when its answer could not be read. Throws
    /// `ThreadSyncError.unknownThread` for a thread the host does not have.
    func markThread(_ thread: ThreadRef.ID, _ marks: ThreadMarks) async throws -> ListedThread?
    /// Gives one of the host's threads a title of the user's. Throws
    /// `ThreadSyncError.refused` with the host's sentence for a title it does not take.
    func renameThread(_ thread: ThreadRef, to title: String) async throws
    /// Takes a thread off the host's list, so it leaves every device; the agent keeps
    /// its session. Throws `ThreadSyncError.refused` with the host's sentence for a thread
    /// it will not remove (one at work).
    func removeThread(_ thread: ThreadRef.ID) async throws
}

/// A host that keeps the list and also which of its threads are recent, for every device
/// (a Portals bridge's `recent_threads`): the mark goes through `markThread` and comes back
/// on the listed thread, as a pin does. Elsewhere that is the device's own (`RecentThreads`).
public protocol RecentThreadKeeping: Sendable {
    /// Whether the host does, as of the last connection; nil before the first.
    var keepsRecentThreads: Bool? { get async }
}

// MARK: What a device keeps

/// A change made on this device to one of a host's threads, which the host has not taken
/// yet. Only the keys given are changes; `remove` takes the thread off the host's list.
public struct PendingThreadChange: Codable, Hashable, Sendable {
    public var thread: ThreadRef.ID
    public var pinned: Bool?
    public var archived: Bool?
    public var unseen: Bool?
    public var title: String?
    public var preview: String?
    public var shared: Bool?
    public var recent: Bool?
    public var remove: Bool?
    /// With `title`: the title the thread had here before it, "" for none, which it gets
    /// back should the host say no to the new one. Not a change itself.
    public var titleBefore: String?

    public init(
        thread: ThreadRef.ID, pinned: Bool? = nil, archived: Bool? = nil, unseen: Bool? = nil, title: String? = nil,
        preview: String? = nil, shared: Bool? = nil, remove: Bool? = nil, recent: Bool? = nil
    ) {
        self.thread = thread
        self.recent = recent
        self.pinned = pinned
        self.archived = archived
        self.unseen = unseen
        self.title = title
        self.preview = preview
        self.shared = shared
        self.remove = remove
    }

    /// Nothing is left to send.
    public var isEmpty: Bool {
        pinned == nil && archived == nil && unseen == nil && title == nil && preview == nil && shared == nil && recent == nil && remove == nil
    }

    /// The marks it sets (`thread.mark`), when it sets any.
    public var marks: ThreadMarks? {
        guard pinned != nil || archived != nil || unseen != nil || preview != nil || shared != nil || recent != nil else { return nil }
        return ThreadMarks(pinned: pinned, archived: archived, unseen: unseen, preview: preview, shared: shared, recent: recent)
    }

    /// The marks alone, without the title or a removal.
    var markPart: PendingThreadChange {
        PendingThreadChange(thread: thread, pinned: pinned, archived: archived, unseen: unseen, preview: preview, shared: shared, recent: recent)
    }

    /// The keys `newer` gives, over these.
    mutating func take(_ newer: PendingThreadChange) {
        pinned = newer.pinned ?? pinned
        archived = newer.archived ?? archived
        unseen = newer.unseen ?? unseen
        title = newer.title ?? title
        preview = newer.preview ?? preview
        shared = newer.shared ?? shared
        recent = newer.recent ?? recent
        remove = newer.remove ?? remove
        // The title from before the first of the titles not sent yet.
        titleBefore = titleBefore ?? newer.titleBefore
    }

    /// The keys a change can give.
    enum Key: CaseIterable {
        case pinned, archived, unseen, title, preview, shared, recent, remove
    }

    /// The keys this change gives.
    var keys: [Key] {
        Key.allCases.filter { key in
            switch key {
            case .pinned: pinned != nil
            case .archived: archived != nil
            case .unseen: unseen != nil
            case .title: title != nil
            case .preview: preview != nil
            case .shared: shared != nil
            case .recent: recent != nil
            case .remove: remove != nil
            }
        }
    }

    /// The same change without `key`.
    func leavingOut(_ key: Key) -> PendingThreadChange {
        var change = self
        switch key {
        case .pinned: change.pinned = nil
        case .archived: change.archived = nil
        case .unseen: change.unseen = nil
        case .title:
            change.title = nil
            change.titleBefore = nil
        case .preview: change.preview = nil
        case .shared: change.shared = nil
        case .recent: change.recent = nil
        case .remove: change.remove = nil
        }
        return change
    }

    /// Leaves out what the host took (`sent`), where it is still what was sent: a key
    /// changed again meanwhile stays, with its new value.
    mutating func settle(_ sent: PendingThreadChange) {
        if let value = sent.pinned, pinned == value { pinned = nil }
        if let value = sent.archived, archived == value { archived = nil }
        if let value = sent.unseen, unseen == value { unseen = nil }
        if let value = sent.title, title == value {
            title = nil
            titleBefore = nil
        }
        if let value = sent.preview, preview == value { preview = nil }
        if let value = sent.shared, shared == value { shared = nil }
        if let value = sent.recent, recent == value { recent = nil }
        if let value = sent.remove, remove == value { remove = nil }
    }
}

/// What a device keeps about one host that keeps the list (`sync.json`).
public struct HostSyncState: Codable, Hashable, Sendable {
    /// The host's list as last merged here; nil while the host does not keep the list
    /// (its last `gateway.ready` lacked the feature), until it is merged again. A
    /// revision below 0 asks for every thread of that list again, as one the host said no
    /// to a change of may not be in any answer of what changed.
    public var list: ThreadListRevision?
    /// Changes made here that the host has not taken yet, oldest first.
    public var pending: [PendingThreadChange]
    /// The host keeps which of its threads are recent (`recent_threads`), and has what this
    /// device kept of them (`RecentThreads`): from the first step that found so until a
    /// connection finds the host without it. nil is false.
    public var keepsRecent: Bool?

    public init(list: ThreadListRevision? = nil, pending: [PendingThreadChange] = [], keepsRecent: Bool? = nil) {
        self.list = list
        self.pending = pending
        self.keepsRecent = keepsRecent
    }
}

// MARK: Merging

/// A thread marked seen here that the host is to be told about, with its revision as
/// last listed, and the list that is a revision of.
public struct SeenThread: Hashable, Sendable {
    public var thread: ThreadRef.ID
    public var revision: Int
    public var list: String
    /// The turn seen, for one read here before the list had its end (`ThreadMarks.turn`).
    public var turn: Int?

    public init(thread: ThreadRef.ID, revision: Int, list: String, turn: Int? = nil) {
        self.thread = thread
        self.revision = revision
        self.list = list
        self.turn = turn
    }
}

/// An answer from the host merged into what the device holds for it.
public struct ThreadMerge: Hashable, Sendable {
    /// The host's threads as the device now holds them, most recently active first. A
    /// thread with a removal on its way is among them: it is hidden, not gone.
    public var threads: [ThreadRecord]
    /// Threads the host took off its list, forgotten here with their transcripts.
    public var forgotten: [ThreadRecord]
    /// The changes still to send, with what a carry-over added.
    public var pending: [PendingThreadChange]
    /// The list as merged.
    public var list: ThreadListRevision
    /// Threads seen here that the host has unseen, for the host to be told: the thread
    /// looked at, which the merge found unseen and marked seen here, and on a carry-over
    /// those this device had seen since their last turn.
    public var seen: [SeenThread]
    /// Threads with a recent mark that a list replacing the old one leaves out: kept here
    /// only from now on, where a mark means nothing, so they are this device's own to keep
    /// as recent (`HostSync.recentReturned`).
    public var recentReturned: Set<ThreadRef.ID> = []
}

/// How an answer from a host that keeps the list is merged into the threads a device
/// holds for that host (docs/sync-plan.md, "How the app merges"). Pure: it reads and
/// writes nothing.
public enum ThreadSync {
    /// - Parameters:
    ///   - answer: what the host said changed (`threads.changes`).
    ///   - held: the host's threads as the device holds them now, hidden ones too.
    ///   - heldWhenAsking: the threads the device held when it asked. Only they can be
    ///     forgotten: a thread started here while the answer was on its way may be newer
    ///     than the answer.
    ///   - pending: the changes made here that the host has not taken yet.
    ///   - list: the list the device merged last, if any.
    ///   - lookedAt: the thread looked at now (notifications are held back for it).
    ///   - readHere: threads read here before the host's list had their turn's end
    ///     (`EndedOutOfSight.readHere`), each with what is known of the turn read
    ///     (`TurnRead`): seen as the one looked at is, unless the list's latest turn is a
    ///     later one.
    public static func merge(
        _ answer: ThreadListChanges,
        into held: [ThreadRecord],
        heldWhenAsking: Set<ThreadRef.ID>,
        pending: [PendingThreadChange],
        list: ThreadListRevision?,
        host: HostID,
        lookedAt: ThreadRef.ID? = nil,
        readHere: [ThreadRef.ID: TurnRead] = [:]
    ) -> ThreadMerge {
        var records = Records(held)
        var pending = pending
        let listed = Set(answer.threads.map(\.id)).union(answer.unreadable)
        let removed = Set(answer.removed)

        // 1. A list this device has not merged before: the marks it holds are sent up
        // once, and threads the host never had stay here only.
        var seen: [SeenThread] = []
        var recentReturned: Set<ThreadRef.ID> = []
        if answer.isFull, answer.list.id != list?.id {
            for thread in answer.threads {
                guard let mine = records[thread.id] else { continue }
                var change = pending.first { $0.thread == thread.id } ?? PendingThreadChange(thread: thread.id)
                // Marks and a preview older than the thread's last turn are stale:
                // something new in a thread brings it back and is worth seeing, and its
                // preview is newer than this device's.
                let current = thread.updated <= mine.updatedAt
                if mine.isPinned, !thread.pinned, change.pinned == nil { change.pinned = true }
                if mine.isShared, !thread.shared, change.shared == nil { change.shared = true }
                // Only a host that kept them says a thread is recent, so this is a list of
                // such a host's that came to replace the one that had the mark.
                if mine.isRecent, !thread.recent, change.recent == nil { change.recent = true }
                if current, mine.isArchived, !thread.archived, change.archived == nil { change.archived = true }
                if current, mine.isUnseen, !thread.unseen, change.unseen == nil { change.unseen = true }
                // Seen here since its last turn, which the host marked unseen while this
                // device could not say so (an app from before the list): seen everywhere.
                if current, !mine.isUnseen, thread.unseen, change.unseen == nil {
                    seen.append(SeenThread(thread: thread.id, revision: thread.revision, list: answer.list.id))
                }
                if current, thread.preview == nil, change.preview == nil, let preview = mine.preview,
                   !preview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    change.preview = preview
                }
                guard !change.isEmpty else { continue }
                if let index = pending.firstIndex(where: { $0.thread == thread.id }) {
                    pending[index] = change
                } else {
                    pending.append(change)
                }
            }
            for id in heldWhenAsking where !listed.contains(id) && !removed.contains(id) {
                records[id]?.localOnly = true
                if records[id]?.isRecent == true {
                    records[id]?.recent = nil
                    recentReturned.insert(id)
                }
            }
        }

        // 2. Threads taken off the list are forgotten, and in a full answer every one it
        // does not list that is not kept here only.
        var forgotten: [ThreadRecord] = []
        // An answer of what changed that takes nothing off the list lets go of nothing.
        if answer.isFull || !removed.isEmpty {
            for id in heldWhenAsking {
                guard let record = records[id] else { continue }
                let gone = removed.contains(id) || (answer.isFull && !listed.contains(id) && record.localOnly != true)
                guard gone else { continue }
                forgotten.append(record)
                records[id] = nil
            }
        }
        let forgottenIDs = Set(forgotten.map(\.id))
        pending.removeAll { forgottenIDs.contains($0.thread) }

        // 3. Each listed thread as the host has it, except what is pending here, and a
        // seen carried over, which stays.
        let carriedSeen = Set(seen.map(\.thread))
        for thread in answer.threads {
            let change = pending.first { $0.thread == thread.id }
            let isNew = records[thread.id] == nil
            var record = records[thread.id] ?? ThreadRecord(
                ref: ThreadRef(id: thread.id, agent: Agent.ID(host: host, name: thread.agent)),
                updatedAt: thread.updated
            )
            record.ref.agent = Agent.ID(host: host, name: thread.agent)
            // A title is never cleared.
            record.ref.title = change?.title ?? thread.title ?? record.ref.title
            if let folder = thread.folder, !folder.isEmpty { record.ref.workingDirectory = folder }
            record.ref.readOnly = thread.readOnly ? true : nil
            record.ref.ongoing = thread.ongoing ? true : nil
            if let created = thread.created { record.ref.createdAt = created }
            // The host's time, so every device orders the list by one clock.
            record.updatedAt = thread.updated
            record.revision = thread.revision
            record.turn = thread.turn
            record.preview = thread.preview ?? record.preview
            record.pinned = (change?.pinned ?? thread.pinned) ? true : nil
            record.archived = (change?.archived ?? thread.archived) ? true : nil
            record.unseen = !carriedSeen.contains(thread.id) && (change?.unseen ?? thread.unseen) ? true : nil
            record.startedBy = thread.startedBy
            record.shared = (change?.shared ?? thread.shared) ? true : nil
            record.recent = (change?.recent ?? thread.recent) ? true : nil
            record.branch = thread.branch
            record.repo = thread.repo
            record.localOnly = nil
            if isNew { record.fromHost = true }
            records[thread.id] = record
        }

        // 4. The thread looked at has been seen, whatever finished in it, and so have the
        // ones read here before the list had their turn's end: but for a later turn the list
        // has, from another device. The seen of one read here names the turn read, which the
        // host checks too; its revision is the one listed now, past that turn's end.
        for id in Set(readHere.keys).union(lookedAt.map { [$0] } ?? []).sorted(by: { $0.rawValue < $1.rawValue }) {
            guard var record = records[id], record.isUnseen else { continue }
            // Read here: of the turn read, named for the host to check as it takes the seen.
            var named: Int?
            if id != lookedAt, let read = readHere[id], let latest = record.turn {
                guard read.covers(latest, in: answer.list.id) else { continue }
                named = latest
            }
            record.unseen = nil
            records[id] = record
            if let index = pending.firstIndex(where: { $0.thread == id }) {
                pending[index].unseen = nil
                if pending[index].isEmpty { pending.remove(at: index) }
            }
            if let revision = record.revision, record.localOnly != true {
                seen.append(SeenThread(thread: id, revision: revision, list: answer.list.id, turn: named))
            }
        }

        return ThreadMerge(
            threads: records.inOrder,
            forgotten: forgotten,
            pending: pending,
            list: answer.list,
            seen: seen,
            recentReturned: recentReturned
        )
    }
}

/// The threads a merge works on: found by id as in a table, and kept in the order they
/// were held in. The held threads are in the list's order already, but for the few a
/// merge changes, and putting a list in order that nearly is costs little, where a
/// table's values come out in no order at all.
private struct Records {
    private var list: [ThreadRecord?] = []
    private var places: [ThreadRef.ID: Int] = [:]

    /// Of two held threads with one id the later stays, as in a table.
    init(_ held: [ThreadRecord]) {
        list.reserveCapacity(held.count)
        places.reserveCapacity(held.count)
        for record in held { self[record.id] = record }
    }

    subscript(id: ThreadRef.ID) -> ThreadRecord? {
        get { places[id].flatMap { list[$0] } }
        set {
            if let place = places[id] {
                list[place] = newValue
                if newValue == nil { places[id] = nil }
            } else if let newValue {
                places[id] = list.count
                list.append(newValue)
            }
        }
    }

    /// Most recently active first; threads of one time by their ids.
    var inOrder: [ThreadRecord] {
        list.compactMap { $0 }.sorted { ($0.updatedAt, $0.id.rawValue) > ($1.updatedAt, $1.id.rawValue) }
    }
}

// MARK: What a device does with its own copy

extension ThreadRecord {
    /// The entry an open thread saves over this one (`open`: the thread as it has it now,
    /// with its title, last message, time and context).
    ///
    /// On a host that keeps the list (`hostKeepsList`), only its time (when the open
    /// thread's is later: a message sent here moves it up at once, until the host's list
    /// gives its own) and its context are taken. Its title, preview and marks are the
    /// host's, so an open thread that has fallen behind never undoes a change made on
    /// another device. Elsewhere the open thread says, as before, keeping the pin; it is
    /// seen when it is on screen (`isOnScreen`), and something new in it brings it out of
    /// the archive.
    public func saving(_ open: ThreadRecord, hostKeepsList: Bool, isOnScreen: Bool) -> ThreadRecord {
        if hostKeepsList {
            var record = self
            if open.updatedAt > updatedAt { record.updatedAt = open.updatedAt }
            record.context = open.context ?? context
            return record
        }
        var record = open
        // What a host that keeps the list said of the thread stays as it said.
        record.startedBy = startedBy
        record.shared = shared
        record.recent = recent
        record.revision = revision
        record.fromHost = fromHost
        record.localOnly = localOnly
        record.pinned = pinned
        record.unseen = isOnScreen ? nil : unseen
        record.archived = open.updatedAt > updatedAt ? nil : archived
        return record
    }

    /// Whether Remove is offered for the thread. On a host that keeps the list it takes
    /// the thread off every device, so it is not offered while the thread is at work
    /// (`atWork`: running, or waiting for an answer), which is stopped first. A thread kept on this device only, and any
    /// thread elsewhere, leaves only this device, at any time, as before. An agent's one
    /// ongoing conversation is always there (`ThreadRef.ongoing`).
    public func offersRemoval(hostKeepsList: Bool, atWork: Bool) -> Bool {
        guard !ref.isOngoing else { return false }
        guard hostKeepsList, !isLocalOnly else { return true }
        return !atWork
    }
}
