import Foundation

/// The top half of the sidebar: what is going on across every Mac at once (2026-10-23). Needs you, Running, Finished, Pinned, then Recent, each thread in one of them
/// at most.
/// Every group but Pinned is in the order its threads last ran (a turn started or ended,
/// `ThreadRecord.updatedAt`), the last first, never in the order they were opened: going
/// through the tabs moves nothing here. A thread here is in its folder below as well.
public struct SidebarGroups: Hashable, Sendable {
    /// Waiting on an answer from you, a thread an agent started that is out of the
    /// sidebar too (`StartedThreads.tucked`), since nothing else would show it.
    public var waiting: [ThreadRecord] = []
    public var running: [ThreadRecord] = []
    /// The results not read yet, with their dot, pinned or archived ones too, all of them
    /// whatever Recent shows (2026-11-03: "finished should be separate from recent"),
    /// until each is read or dismissed. Never a thread out of the sidebar (`tucked`).
    public var finished: [ThreadRecord] = []
    /// The threads pinned, at rest and read (2026-11-03: "pinned should be above
    /// recent"), the one created last first, so that each keeps its place as turns end. One
    /// that is running, waiting for you or not read yet is in those groups, with its pin,
    /// for that long. What Recent shows does not change this: a device with Recent off still
    /// has its pins.
    public var pinned: [ThreadRecord] = []
    /// The recent threads, read and at rest, as far as this device shows them
    /// (`RecentChoice`). Open tabs do not decide what stays here. Never a thread out of the
    /// sidebar (`tucked`), nor one archived or pinned.
    public var recent: [ThreadRecord] = []
    /// Local history after pruning: the app persists this after the layout changes.
    public private(set) var history = RecentThreads()
    /// The read, idle threads a host keeps as recent (`ThreadRecord.recent`), the one that
    /// last ran first, also those this device does not show: what `RecentThreads.pastKept`
    /// counts.
    public private(set) var marked: [ThreadKey] = []

    /// Whether a mark on this thread would come straight off again: its host has as many
    /// marks as are kept (`RecentThreads.pastKept`), each of which last ran after it
    /// (`lastRan`), and the thread is at rest, so that it counts.
    public func markWouldPassKept(_ record: ThreadRecord, lastRan: (ThreadKey) -> Date?) -> Bool {
        let key = record.key
        let last = marked.lazy.filter { $0.host == key.host }.dropFirst(RecentThreads.readLimit - 1).first
        guard let last, let time = lastRan(last), !(running + waiting).contains(where: { $0.key == key }) else { return false }
        return record.updatedAt < time
    }

    public init(
        waiting: [ThreadRecord] = [], running: [ThreadRecord] = [], finished: [ThreadRecord] = [],
        pinned: [ThreadRecord] = [], recent: [ThreadRecord] = []
    ) {
        self.waiting = waiting
        self.running = running
        self.finished = finished
        self.pinned = pinned
        self.recent = recent
    }

    public var isEmpty: Bool { waiting.isEmpty && running.isEmpty && finished.isEmpty && pinned.isEmpty && recent.isEmpty }

    /// How many rows the groups hold, which the top half's height is worked out from.
    public var count: Int { waiting.count + running.count + finished.count + pinned.count + recent.count }

    /// - Parameters:
    ///   - threads: the threads the sidebar lists, every host's, in any order.
    ///   - recent: the conversations used on this device that no host keeps for it
    ///     (`RecentThreads`); those a host keeps say so themselves (`ThreadRecord.recent`).
    ///   - choice: how much of Recent this device shows (`RecentChoice`).
    ///   - tucked: the threads an agent started that are under the thread that started
    ///     them and not in the sidebar (`StartedThreads.tucked`): only in Needs you, open
    ///     as tabs here or not (2026-10-27: "if we click on a managed thread but
    ///     not on open in sidebar it shouldnt stay in the running view on the sidebar").
    ///     Opened from the foot of its starter's chat, one is a tab, which a device with
    ///     tabs shows over the chat; Show in sidebar alone puts one in Running and Recent.
    public static func build(
        threads: [ThreadRecord], recent: RecentThreads, waiting: Set<ThreadKey>, running: Set<ThreadKey>,
        tucked: Set<ThreadKey> = [], choice: RecentChoice = RecentChoice()
    ) -> SidebarGroups {
        build(newestFirst: SidebarSections.newestFirst(threads), recent: recent, waiting: waiting, running: running,
              tucked: tucked, choice: choice)
    }

    /// `build`, with `threads` in their order already.
    static func build(
        newestFirst threads: [ThreadRecord], recent: RecentThreads, waiting: Set<ThreadKey>, running: Set<ThreadKey>,
        tucked: Set<ThreadKey>, choice: RecentChoice = RecentChoice()
    ) -> SidebarGroups {
        var groups = SidebarGroups()
        groups.history = recent.reconciled(newestFirst: threads, active: waiting.union(running), tucked: tucked)
        var read: [ThreadRecord] = []
        for record in threads {
            let key = record.key
            if waiting.contains(key) {
                groups.waiting.append(record)
            } else if tucked.contains(key) {
                continue
            } else if running.contains(key) {
                groups.running.append(record)
            } else if record.isUnseen {
                groups.finished.append(record)
            } else if record.isArchived {
                continue
            } else if record.isPinned {
                groups.pinned.append(record)
            } else if record.isRecent || groups.history.keys.contains(key) {
                read.append(record)
            }
        }
        groups.pinned = SidebarSpace.folderOrder(groups.pinned)
        // The choice limits only what shows.
        groups.marked = read.filter(\.isRecent).map(\.key)
        groups.recent = Array(read.prefix(choice.readShown))
        return groups
    }

    /// One of the groups.
    public enum Group: String, Hashable, Sendable, CaseIterable {
        case waiting
        case running
        case finished
        case pinned
        case recent
    }

    /// One line of the groups as the sidebar lists them, all in one list: a group's
    /// title, or a thread's row. Each line has an identity of its own, never another's
    /// at the same time (`id`). A title is told apart by its place among the groups
    /// shown, so that when one group goes and the next takes its place, the title there
    /// changes its words where it is. A row is told apart by its group and its thread:
    /// a thread going to another group is a new row there, and one staying in its group
    /// keeps its row as the groups above it come and go.
    ///
    /// With a list for each group, a row whose group moved to another place went from
    /// one list to the next under one identity, the row leaving and the row coming in
    /// both there for a moment; the sidebar's lazy stack then kept drawing the row as it
    /// was before the move, never again brought up to date (seen on 2026-10-24: a recent
    /// thread drawn without its agent's logo, its age and its state as they were at
    /// launch, from before its host was reached, under Running come in above it).
    public enum Line: Identifiable, Hashable, Sendable {
        case title(Group, place: Int)
        case thread(ThreadRecord, in: Group)

        public var id: String {
            switch self {
            case let .title(_, place): "title|\(place)"
            case let .thread(record, group): "\(group.rawValue)|\(record.key.host.rawValue)|\(record.id.rawValue)"
            }
        }
    }

    /// The groups that have threads, in their order, each one's title and then its rows.
    public var lines: [Line] {
        let shown = [(Group.waiting, waiting), (.running, running), (.finished, finished), (.pinned, pinned), (.recent, recent)].filter { !$0.1.isEmpty }
        return shown.enumerated().flatMap { place, group in
            [Line.title(group.0, place: place)] + group.1.map { Line.thread($0, in: group.0) }
        }
    }
}

/// One Mac's part of the sidebar, below the groups: a "space", one shown at a time, the
/// others a swipe away, in the Macs' order (`machine_order`). Its bots as a strip of
/// avatars, then its folders with their threads, then what it archived.
public struct SidebarSpace: Identifiable, Hashable, Sendable {
    public var host: HostConfig
    /// The agents that are talked with rather than set to work in a folder (a Hermes
    /// profile, `Agent.needsNoFolder`), in the order the user gave them, or else as the
    /// host lists them; every agent of a host that offers no folders. Each with its
    /// threads, wherever they work, the one that last ran first: the one its avatar
    /// opens.
    public var bots: [SidebarAgent] = []
    /// The folders with a thread that is not archived, and the ones the user added on the
    /// host, each where it stays as work starts and ends in it (2026-10-24): the
    /// ones the user placed in that order, then the others from the one first seen last
    /// (the earlier of its oldest thread's start and when it was added, as first seen:
    /// `SidebarLayout.firstSeen`), No project last; or by when each was last worked in,
    /// where the user asked for that. In each, its pinned threads first, then the rest,
    /// the one created last first: a thread
    /// keeps its place as turns start and end in it. A bot's threads in the host's
    /// General folder are the bot's alone; any other thread working in no folder is in
    /// No project.
    public var folders: [SidebarProject] = []
    /// The host's archived threads, the one that last ran first.
    public var archived: [ThreadRecord] = []

    public init(host: HostConfig, bots: [SidebarAgent] = [], folders: [SidebarProject] = [], archived: [ThreadRecord] = []) {
        self.host = host
        self.bots = bots
        self.folders = folders
        self.archived = archived
    }

    public var id: HostID { host.id }
}

extension SidebarSpace {
    /// A folder's threads as a space lists them: pinned first, then the one created last
    /// first; threads created at one moment by their ids.
    static func folderOrder(_ threads: [ThreadRecord]) -> [ThreadRecord] {
        threads.sorted { one, other in
            if one.isPinned != other.isPinned { return one.isPinned }
            if one.ref.createdAt != other.ref.createdAt { return one.ref.createdAt > other.ref.createdAt }
            return one.id.rawValue > other.id.rawValue
        }
    }
}
