import Foundation

/// One agent in the sidebar, with its threads.
public struct SidebarAgent: Identifiable, Hashable, Sendable {
    public var agent: Agent
    /// Most recently active first.
    public var threads: [ThreadRecord]

    public var id: Agent.ID { agent.id }
}

/// One folder on one host, with the threads that work in it, whichever agent each is
/// with. The same folder name on another host is another project.
public struct SidebarProject: Identifiable, Hashable, Sendable {
    public struct ID: Hashable, Codable, Sendable {
        public var host: HostID
        /// The folder's full path on the host.
        public var path: String

        public init(host: HostID, path: String) {
            self.host = host
            self.path = path
        }

        /// The folder `record` is listed under: the one it works in, or for one working in
        /// a git worktree, its repository's (`ThreadRecord.repo`), never the worktree's
        /// own. nil for a thread with no folder.
        public init?(of record: ThreadRecord) {
            if let repo = record.repo, !repo.isEmpty {
                self.init(host: record.key.host, path: repo)
                return
            }
            guard let path = record.ref.workingDirectory, !path.isEmpty else { return nil }
            self.init(host: record.key.host, path: path)
        }
    }

    public var id: ID
    /// What to call it: "No project" for the host's General folder, the folder's last path
    /// component otherwise.
    public var name: String
    /// Pinned ones first, then the rest, most recently active first.
    public var threads: [ThreadRecord]
    /// Whether the user added the folder on the host (`Folder.isAdded`): it is listed
    /// with no thread in it too, until it is taken off the host's list.
    public var isAdded = false
    /// Whether a thread of it is listed, which is one that is not archived.
    public var hasThreads = true
    /// Whether it is the host's General folder: No project, at the foot of the host's
    /// projects, wherever its last use or the order would put it.
    public var isGeneral = false

    /// Whether taking the folder off the host's list takes the project off the sidebar:
    /// it is there only for having been added.
    public var isOnlyAdded: Bool { isAdded && !hasThreads }
}

/// The sidebar's list, from every host at once (2026-10-23): on top, Needs you,
/// Running and Recent across every host (`top`), and below, one host at a time, its
/// space: its bots, its folders and what it archived (`spaces`). On a host that nests
/// them, a thread an agent started from another thread is under that thread, out of the
/// list.
public struct SidebarLayout: Hashable, Sendable {
    /// The threads an agent started that are listed under the thread that started them
    /// (`StartedThreads.nested`), in the sidebar too or not: the ones Show in sidebar and
    /// Hide are offered for.
    public var nested: Set<ThreadKey> = []
    /// Needs you, Running and Recent, from every host (`SidebarGroups`).
    public var top = SidebarGroups()
    /// A space per host, in the hosts' order (the Macs' order).
    public var spaces: [SidebarSpace] = []
    /// When each folder was first seen, which places it among its host's others
    /// (`SidebarSpace.folders`): what to remember for the next layout, so that a folder
    /// keeps its place whatever its host says later (`SidebarLayoutCache.firstSeen`).
    public var firstSeen: [SidebarProject.ID: Date] = [:]

    /// `withFolders` are the hosts whose agents work in folders the host offers: only
    /// their threads are in projects. `folders` is what each of them lists, as far as it
    /// is known: the ones the user added there are projects from the start. A host it has
    /// no list for has not listed its folders yet (since launch, say), which is not a
    /// host that lists none: what was remembered of its folders is kept until it has.
    /// `order` is the order the user gave each host's agents and folders, where they
    /// gave one: the bots and the folders are listed by it, the threads never.
    /// `nesting` are the hosts that list a thread an agent started from another under
    /// that thread (`StartedThreads`): such a thread is in Needs you while it waits on an
    /// answer, which nothing else would show, and nowhere else in the sidebar.
    /// `recent` is this device's conversation history (`RecentThreads`), and `recentChoice`
    /// how much of Recent it shows (`RecentChoice`).
    /// `foldersByLastUse` are the hosts whose space lists its folders by when each was
    /// last worked in, as the user asked, and not
    /// where they stay (`SidebarSpace.folders`). `firstSeen` is when each folder was first
    /// seen, as an earlier layout had it (`SidebarLayout.firstSeen`).
    public static func build(
        hosts: [HostConfig], agents: [Agent], threads: [ThreadRecord], waiting: Set<ThreadKey>, running: Set<ThreadKey>,
        withFolders: Set<HostID> = [], folders: [HostID: [Folder]] = [:],
        order arranged: [HostID: SidebarOrder] = [:], nesting: Set<HostID> = [],
        recent: RecentThreads = RecentThreads(), foldersByLastUse: Set<HostID> = [],
        firstSeen remembered: [SidebarProject.ID: Date] = [:], recentChoice: RecentChoice = RecentChoice()
    ) -> SidebarLayout {
        let known = Set(agents.map(\.id))
        let newest = SidebarSections.newestFirst(threads.filter { known.contains($0.ref.agent) })
        // A thread started from another Mac's goes under it when that Mac is a host here too.
        let machines = StartedThreads.machines(of: hosts)
        let nested = StartedThreads.nested(newest, nesting: nesting, listed: known, machines: machines)
        let tucked = StartedThreads.tucked(newest, nested: nested)
        var layout = SidebarLayout()
        layout.nested = nested
        layout.top = SidebarGroups.build(
            newestFirst: newest, recent: recent, waiting: waiting, running: running, tucked: tucked, choice: recentChoice
        )
        let agentsByHost = Dictionary(grouping: agents, by: \.id.host).reduce(into: [HostID: [Agent]]()) { byHost, entry in
            byHost[entry.key] = arranged[entry.key]?.arranged(entry.value) ?? entry.value
        }
        let general = Dictionary(hosts.map { ($0.id, $0.generalFolder) }, uniquingKeysWith: { first, _ in first })
        (layout.spaces, layout.firstSeen) = spaces(
            hosts: hosts, agentsByHost: agentsByHost, newest: newest, tucked: tucked, general: general,
            withFolders: withFolders, folders: folders, order: arranged, byLastUse: foldersByLastUse, remembered: remembered
        )
        return layout
    }

    /// The folders listed, from the one worked in last first (`newest` are the threads
    /// listed in them, the one that last ran first), with the ones in use and the ones
    /// the user added on their host. A folder is listed for as long as one of its
    /// threads is not archived (`project` gives a thread's), and one the user added is
    /// listed with no thread at all, where its last use puts it: on top when just added.
    private static func projectOrder(
        _ newest: [ThreadRecord], project: (ThreadRecord) -> SidebarProject.ID?, hosts: [HostConfig],
        withFolders: Set<HostID>, folders: [HostID: [Folder]]
    ) -> (order: [SidebarProject.ID], inUse: Set<SidebarProject.ID>, added: Set<SidebarProject.ID>) {
        var order: [SidebarProject.ID] = []
        var lastUse: [SidebarProject.ID: Date] = [:]
        for record in newest {
            if let id = project(record), lastUse[id] == nil {
                lastUse[id] = record.updatedAt
                order.append(id)
            }
        }
        let inUse = Set(order)
        var added: Set<SidebarProject.ID> = []
        for host in hosts where withFolders.contains(host.id) {
            for folder in folders[host.id] ?? [] where folder.isAdded && folder.path != host.generalFolder {
                let id = SidebarProject.ID(host: host.id, path: folder.path)
                added.insert(id)
                if !inUse.contains(id) { order.append(id) }
                lastUse[id] = max(lastUse[id] ?? .distantPast, folder.lastUsed ?? .distantPast)
            }
        }
        if !added.isEmpty {
            order = order.enumerated()
                .sorted { lastUse[$0.element] != lastUse[$1.element] ? lastUse[$0.element]! > lastUse[$1.element]! : $0.offset < $1.offset }
                .map(\.element)
        }
        return (order, inUse, added)
    }

    /// A space per host (`SidebarSpace`), from `newest`, the threads listed, the one that
    /// last ran first: the bots first, each with every thread of theirs that is not
    /// archived; then the folders, where they stay (`firstSeen`), or by last use on a host
    /// in `byLastUse`; the archived apart. A thread under the thread that started it
    /// (`tucked`) is in none of them. With them, when each folder was first seen, the
    /// dates seen before (`remembered`) taken into account. Internal for SidebarBenchmarks,
    /// which times it apart from the rest.
    static func spaces(
        hosts: [HostConfig], agentsByHost: [HostID: [Agent]], newest: [ThreadRecord], tucked: Set<ThreadKey>,
        general: [HostID: String?], withFolders: Set<HostID>, folders: [HostID: [Folder]], order arranged: [HostID: SidebarOrder],
        byLastUse: Set<HostID>, remembered: [SidebarProject.ID: Date]
    ) -> (spaces: [SidebarSpace], firstSeen: [SidebarProject.ID: Date]) {
        var bots = Set<Agent.ID>()
        for host in hosts {
            for agent in agentsByHost[host.id] ?? [] where !withFolders.contains(host.id) || agent.needsNoFolder(on: host.kind) {
                bots.insert(agent.id)
            }
        }
        // A bot's thread in the General folder is the bot's alone; any other thread of a
        // host with folders is in one, the General folder for one that says none.
        func project(of record: ThreadRecord) -> SidebarProject.ID? {
            let host = record.key.host
            guard withFolders.contains(host) else { return nil }
            let generalPath = general[host] ?? nil
            guard let id = SidebarProject.ID(of: record) else {
                return bots.contains(record.ref.agent) ? nil : SidebarProject.ID(host: host, path: generalPath ?? "")
            }
            if bots.contains(record.ref.agent), id.path == generalPath { return nil }
            return id
        }
        var placed: [ThreadRecord] = []
        var archived: [HostID: [ThreadRecord]] = [:]
        for record in newest where !tucked.contains(record.key) {
            if record.isArchived {
                archived[record.key.host, default: []].append(record)
            } else {
                placed.append(record)
            }
        }
        let (order, inUse, added) = projectOrder(placed, project: project, hosts: hosts, withFolders: withFolders, folders: folders)
        let firstSeen = firstSeen(
            of: newest, project: project, hosts: hosts, withFolders: withFolders, folders: folders, remembered: remembered
        )
        var filed: [SidebarProject.ID: [ThreadRecord]] = [:]
        var byBot: [Agent.ID: [ThreadRecord]] = [:]
        for record in placed {
            if let id = project(of: record) { filed[id, default: []].append(record) }
            if bots.contains(record.ref.agent) { byBot[record.ref.agent, default: []].append(record) }
        }
        let spaces = hosts.map { host in
            let generalPath = host.generalFolder ?? ""
            let listed = order.filter { $0.host == host.id }
            let folderOrder = byLastUse.contains(host.id)
                ? listed.filter { $0.path != generalPath } + listed.filter { $0.path == generalPath }
                : Self.keptInPlace(listed, firstSeen: firstSeen, by: arranged[host.id], general: generalPath)
            return SidebarSpace(
                host: host,
                bots: (agentsByHost[host.id] ?? []).filter { bots.contains($0.id) }.map { SidebarAgent(agent: $0, threads: byBot[$0.id] ?? []) },
                folders: folderOrder.map { id in
                    let isGeneral = id.path == generalPath
                    return SidebarProject(
                        id: id, name: isGeneral ? Folder.generalName : Folder.name(of: id.path, general: host.generalFolder),
                        threads: SidebarSpace.folderOrder(filed[id] ?? []), isAdded: added.contains(id), hasThreads: inUse.contains(id),
                        isGeneral: isGeneral
                    )
                },
                archived: archived[host.id] ?? []
            )
        }
        return (spaces, firstSeen)
    }

    /// When each folder was first seen: the earliest of its oldest thread's start, of
    /// the threads the app has (`newest`, the archived ones too), of when the host says
    /// it was added or last used, for one the user added, and of when it was seen before
    /// (`remembered`). A folder added with no thread keeps its place as its first thread
    /// starts (that thread's start is later than the folder's), also once the host,
    /// which says when a folder was last used rather than when it was added, says a
    /// later date for it. The dates remembered of a host listed without its folders
    /// (not reached since it said it has them), or that has not listed its folders yet
    /// (`folders` has no list for it: a host saved as one that offers folders, at launch,
    /// before it is asked), are kept as they are: a folder with no thread here is missing
    /// then only for not being known yet. One left out of a list the host gave is
    /// forgotten.
    private static func firstSeen(
        of newest: [ThreadRecord], project: (ThreadRecord) -> SidebarProject.ID?, hosts: [HostConfig],
        withFolders: Set<HostID>, folders: [HostID: [Folder]], remembered: [SidebarProject.ID: Date] = [:]
    ) -> [SidebarProject.ID: Date] {
        var firstSeen: [SidebarProject.ID: Date] = [:]
        func seen(_ id: SidebarProject.ID, at date: Date) {
            firstSeen[id] = min(firstSeen[id] ?? date, date)
        }
        for record in newest {
            guard let id = project(record) else { continue }
            seen(id, at: record.ref.createdAt)
        }
        for host in hosts where withFolders.contains(host.id) {
            for folder in folders[host.id] ?? [] where folder.isAdded {
                seen(SidebarProject.ID(host: host.id, path: folder.path), at: folder.lastUsed ?? .distantPast)
            }
        }
        let listed = Set(hosts.map(\.id))
        for (id, date) in remembered where listed.contains(id.host) {
            if firstSeen[id] != nil {
                seen(id, at: date)
            } else if !withFolders.contains(id.host) || folders[id.host] == nil {
                firstSeen[id] = date
            }
        }
        return firstSeen
    }

    /// One host's folders as its space lists them, where they stay as work starts and
    /// ends in them (2026-10-24): the ones the user placed, in that order, then
    /// the others from the one first seen last (a new folder on top of them), and No
    /// project, the General folder, last of all.
    private static func keptInPlace(
        _ listed: [SidebarProject.ID], firstSeen: [SidebarProject.ID: Date], by order: SidebarOrder?, general: String
    ) -> [SidebarProject.ID] {
        let stable = listed.sorted { one, other in
            let seen = (firstSeen[one] ?? .distantPast, firstSeen[other] ?? .distantPast)
            return seen.0 != seen.1 ? seen.0 > seen.1 : one.path < other.path
        }
        let arranged = order?.placedFirst(stable, path: \.path) ?? stable
        return arranged.filter { $0.path != general } + arranged.filter { $0.path == general }
    }
}

/// A sidebar's layout kept with what it was worked out from (`SidebarLayout.build`). The
/// sidebar asks for its layout each time it is drawn, and most of those times nothing the
/// layout is made of changed: a list was folded, the thread on screen changed, a row was
/// held. With 2000 threads working it out takes a few milliseconds; telling that nothing
/// changed, a tenth of that.
public struct SidebarLayoutCache {
    /// Everything `SidebarLayout.build` is given.
    public struct Inputs: Equatable {
        public var hosts: [HostConfig]
        public var agents: [Agent]
        public var threads: [ThreadRecord]
        public var waiting: Set<ThreadKey>
        public var running: Set<ThreadKey>
        public var withFolders: Set<HostID>
        public var folders: [HostID: [Folder]]
        public var order: [HostID: SidebarOrder]
        public var nesting: Set<HostID>
        /// This device's recent history, independent of its open tabs.
        public var recent: RecentThreads
        public var foldersByLastUse: Set<HostID>
        /// How much of Recent this device shows.
        public var recentChoice: RecentChoice

        public init(
            hosts: [HostConfig], agents: [Agent], threads: [ThreadRecord], waiting: Set<ThreadKey>, running: Set<ThreadKey>,
            withFolders: Set<HostID> = [], folders: [HostID: [Folder]] = [:],
            order: [HostID: SidebarOrder] = [:], nesting: Set<HostID> = [], recent: RecentThreads = RecentThreads(),
            foldersByLastUse: Set<HostID> = [], recentChoice: RecentChoice = RecentChoice()
        ) {
            self.recentChoice = recentChoice
            self.hosts = hosts
            self.agents = agents
            self.threads = threads
            self.waiting = waiting
            self.running = running
            self.withFolders = withFolders
            self.folders = folders
            self.order = order
            self.nesting = nesting
            self.recent = recent
            self.foldersByLastUse = foldersByLastUse
        }
    }

    private var inputs: Inputs?
    /// The layout last worked out.
    public private(set) var layout = SidebarLayout()
    /// How many times the layout was worked out, for tests.
    public private(set) var builds = 0
    /// When each folder was first seen, as the layout last worked out had it, given to the
    /// next one (`SidebarLayout.firstSeen`): kept between launches by whoever keeps the
    /// cache, and given back to `init`.
    public private(set) var firstSeen: [SidebarProject.ID: Date]

    public init(firstSeen: [SidebarProject.ID: Date] = [:]) {
        self.firstSeen = firstSeen
    }

    /// The layout for `inputs`: the one kept when they are the same as last time.
    public mutating func layout(for inputs: Inputs) -> SidebarLayout {
        if let kept = self.inputs, kept == inputs { return layout }
        layout = SidebarLayout.build(
            hosts: inputs.hosts, agents: inputs.agents, threads: inputs.threads, waiting: inputs.waiting,
            running: inputs.running, withFolders: inputs.withFolders, folders: inputs.folders,
            order: inputs.order, nesting: inputs.nesting, recent: inputs.recent,
            foldersByLastUse: inputs.foldersByLastUse, firstSeen: firstSeen, recentChoice: inputs.recentChoice
        )
        firstSeen = layout.firstSeen
        self.inputs = inputs
        builds += 1
        return layout
    }
}

extension SidebarSections {
    /// The projects a host's list shows before the rest are folded away: the `count`
    /// first, and any that is open.
    public static func recent(_ projects: [SidebarProject], count: Int, keeping open: Set<SidebarProject.ID>) -> [SidebarProject] {
        projects.enumerated().filter { index, project in index < count || open.contains(project.id) }.map(\.element)
    }
}

/// What the sidebar's lists show, from every host at once.
public enum SidebarSections {
    /// The threads a list shows before the rest are folded away: every pinned one, the
    /// `count` first of the others, and the one on screen wherever it is in the list.
    public static func recent(_ threads: [ThreadRecord], count: Int, keeping current: ThreadKey?) -> [ThreadRecord] {
        var others = 0
        return threads.filter { record in
            if record.isPinned { return true }
            others += 1
            return others <= count || record.key == current
        }
    }

    /// The threads whose title or last message holds `query`, from every host, most
    /// recently active first. Nothing for an empty query.
    public static func search(_ query: String, in threads: [ThreadRecord]) -> [ThreadRecord] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }
        let holds = StandardContains(needle)
        return newestFirst(threads.filter {
            holds.isIn($0.displayTitle) || ($0.preview.map(holds.isIn) ?? false)
        })
    }

    /// Stable: threads active at the same moment keep the order they came in.
    static func newestFirst(_ threads: [ThreadRecord]) -> [ThreadRecord] {
        threads.enumerated()
            .sorted { $0.element.updatedAt != $1.element.updatedAt ? $0.element.updatedAt > $1.element.updatedAt : $0.offset < $1.offset }
            .map(\.element)
    }
}

/// `localizedStandardContains` for one needle over many texts: the same test, with the
/// locale bridged once rather than for each text. Foundation's `localizedStandardContains`
/// is `range(of:options: [.caseInsensitive, .diacriticInsensitive], locale: .current)`,
/// which bridges the locale to `NSLocale` at every call and then asks CoreFoundation, as
/// this does (`NSString`'s search is non-literal unless asked to be literal). The bridging
/// was half of what a search of the sidebar cost as each key was typed (2026-11-06,
/// scripts/type-bench.sh --search).
public struct StandardContains {
    private let needle: CFString
    private let isEmpty: Bool
    private let locale: CFLocale

    public init(_ needle: String) {
        self.needle = needle as CFString
        isEmpty = needle.isEmpty
        locale = Locale.current as CFLocale
    }

    /// Whether `text` holds the needle, as `text.localizedStandardContains(needle)` says.
    public func isIn(_ text: String) -> Bool {
        guard !isEmpty else { return false }
        let text = text as CFString
        let options: CFStringCompareFlags = [.compareCaseInsensitive, .compareDiacriticInsensitive, .compareNonliteral]
        return CFStringFindWithOptionsAndLocale(
            text, needle, CFRange(location: 0, length: CFStringGetLength(text)), options, locale, nil
        )
    }
}
